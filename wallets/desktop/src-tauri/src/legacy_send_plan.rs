//! Legacy/MFW confirmations reuse the shared durable, one-shot payment core.
use crate::{
    diagnostics, lock_native_wallet, now, pending_outgoing, require_app_unlocked,
    send_physical_identity, send_plan, send_plan_store, AppProtectionState, NativeWalletState,
    PendingTransactionApproval, SendPlanNative,
};
use send_plan::Journal;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn account_index(prepared: &Value) -> Result<u32, String> {
    let accounts = prepared
        .get("subaddressAccounts")
        .and_then(Value::as_array)
        .ok_or("The native transaction has no verified account scope.")?;
    let mut account = None;
    for value in accounts {
        let index = value
            .as_u64()
            .or_else(|| value.as_str()?.parse().ok())
            .and_then(|v| u32::try_from(v).ok())
            .ok_or("The native transaction account is invalid.")?;
        if account.is_some_and(|known| known != index) {
            return Err("The native legacy review contains multiple accounts.".to_owned());
        }
        account = Some(index);
    }
    account.ok_or_else(|| "The native transaction has no verified account scope.".to_owned())
}
fn validate(app: &AppHandle, plan: &send_plan::Plan) -> Result<(), String> {
    require_app_unlocked(&app.state::<AppProtectionState>())?;
    plan.financials()?;
    for binding in &plan.bindings {
        for id in [&binding.read_wallet_id, &binding.signing_wallet_id] {
            if send_physical_identity(app, id, Some(&binding.network))? != binding.physical_id {
                return Err(
                    "The native payment source changed. Nothing further was sent.".to_owned(),
                );
            }
        }
    }
    Ok(())
}

pub(super) fn commit(
    app: &AppHandle,
    state: &NativeWalletState,
    approval: &PendingTransactionApproval,
    read_wallet_id: &str,
    signing_wallet_id: &str,
    registration_id: Option<&str>,
) -> Result<String, String> {
    require_app_unlocked(&app.state::<AppProtectionState>())?;
    if approval.expires_at <= now() {
        return Err("The transaction review expired. Prepare it again.".to_owned());
    }
    let prepared: send_plan::Prepared = serde_json::from_value(approval.prepared.clone())
        .map_err(|_| "The native transaction review is invalid.".to_owned())?;
    let account_index = account_index(&approval.prepared)?;
    let physical = send_physical_identity(app, signing_wallet_id, None)?;
    let network = physical
        .split(':')
        .nth(1)
        .ok_or("Native wallet network is unavailable.")?
        .to_owned();
    let source = send_plan::Source {
        kind: "registered".to_owned(),
        id: registration_id.unwrap_or(&physical).to_owned(),
    };
    let primary =
        lock_native_wallet(app, state, "legacy-send-source")?.address(signing_wallet_id, 0, 0)?;
    let label = format!(
        "Wallet {}…{}",
        primary.chars().take(8).collect::<String>(),
        primary
            .chars()
            .rev()
            .take(6)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    );
    let binding = send_plan::Binding {
        source,
        label,
        network,
        physical_id: physical,
        read_wallet_id: read_wallet_id.to_owned(),
        signing_wallet_id: signing_wallet_id.to_owned(),
        owner_registration_id: registration_id.map(str::to_owned),
    };
    let id = send_plan::new_id()?;
    let plans = send_plan_store(app);
    let mut journal = send_plan::VaultJournal;
    let mut native = SendPlanNative { app, state };
    plans
        .0
        .lock()
        .map_err(|_| "Payment state is busy.")?
        .reserve(id.clone(), vec![binding], &mut journal)?;
    let mut plan = plans
        .0
        .lock()
        .map_err(|_| "Payment state is busy.")?
        .get(&id)
        .ok_or("Native payment reservation was lost.")?;
    plan.address = approval.address.clone();
    plan.members.push(send_plan::Member {
        binding_index: 0,
        account_index,
        prepared,
        broadcasted: Vec::new(),
        known_amount_atomic: None,
        known_fee_atomic: None,
        totals_unknown: false,
    });
    let ready = (|| {
        validate(app, &plan)?;
        let published = plans
            .0
            .lock()
            .map_err(|_| "Payment state is busy.")?
            .publish(plan.clone(), now())?;
        journal.save(&published)?;
        Ok::<_, String>(published)
    })();
    let ready = match ready {
        Ok(plan) => plan,
        Err(error) => {
            if send_plan::discard(&mut native, &mut plan).is_err() {
                plan.phase = "cleanup_failed".to_owned();
                plan.lease_held = true;
            }
            plan.error = Some(error.clone());
            plans
                .0
                .lock()
                .map_err(|_| "Payment state is busy.")?
                .replace(plan);
            return Err(error);
        }
    };
    // The existing trusted native dialog and fresh app authorization preceded
    // this private adoption. No claim token or executable handle reaches JS.
    let (authorizing, claim) = plans
        .0
        .lock()
        .map_err(|_| "Payment state is busy.")?
        .claim(&ready.id, now())?;
    if let Err(error) = journal.save(&authorizing) {
        plans
            .0
            .lock()
            .map_err(|_| "Payment state is busy.")?
            .release_claim(&ready.id, claim);
        return Err(error);
    }
    validate(app, &authorizing)?;
    let mut executing = plans
        .0
        .lock()
        .map_err(|_| "Payment state is busy.")?
        .start(&ready.id, claim, now())?;
    send_plan::commit(&mut native, &mut journal, &mut executing, |current| {
        validate(app, current)?;
        let stored = plans
            .0
            .lock()
            .map_err(|_| "Payment state is busy.")?
            .get(&current.id)
            .ok_or("The app session changed. Nothing further was sent.")?;
        if stored.phase != "broadcasting" || stored.claim != claim {
            return Err("The transaction approval is no longer current.".to_owned());
        }
        plans
            .0
            .lock()
            .map_err(|_| "Payment state is busy.")?
            .replace(current.clone());
        Ok(())
    });
    let public = executing.public();
    for member in &executing.members {
        if let Some(owner) = registration_id {
            if let Err(error) = pending_outgoing::record_details(
                owner,
                &member.broadcasted,
                &executing.address,
                now(),
            ) {
                diagnostics::record(
                    app,
                    "wallet.legacy-pending-history-failed",
                    &[("error", error)],
                );
            }
        }
    }
    plans
        .0
        .lock()
        .map_err(|_| "Payment state is busy.")?
        .replace(executing);
    let mut result = approval.prepared.clone();
    result["status"] = json!(
        if public["status"] == "ok" && public["phase"] == "complete" {
            "ok"
        } else {
            "error"
        }
    );
    result["error"] = public["error"]
        .as_str()
        .map(|s| json!(s))
        .unwrap_or_else(|| json!(""));
    if result["status"] == "error" && result["error"] == "" {
        result["error"]=json!("The transaction outcome needs verification. Inspect the saved payment receipt; do not send again.");
    }
    result["sendPlanId"] = json!(ready.id);
    for key in [
        "broadcastAttempted",
        "broadcastedTxIds",
        "uncertainTxIds",
        "remainingTxIds",
        "broadcastedAmountAtomic",
        "broadcastedFeeAtomic",
        "broadcastedTotalsKnown",
    ] {
        result[key] = public[key].clone();
    }
    serde_json::to_string(&result)
        .map_err(|_| "The saved payment receipt could not be encoded.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_legacy_account_scope_is_explicit_and_never_inferred_as_zero() {
        assert_eq!(
            account_index(&json!({"subaddressAccounts":[3,3]})).unwrap(),
            3
        );
        assert_eq!(
            account_index(&json!({"subaddressAccounts":["2"]})).unwrap(),
            2
        );
        for value in [
            json!({}),
            json!({"subaddressAccounts":[]}),
            json!({"subaddressAccounts":[0,1]}),
            json!({"subaddressAccounts":[-1]}),
            json!({"subaddressAccounts":[4294967296u64]}),
        ] {
            assert!(account_index(&value).is_err());
        }
    }
}
