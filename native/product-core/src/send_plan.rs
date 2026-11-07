//! Immutable, process-local send plans. Only encrypted receipts survive restart;
//! restarted receipts can never recreate or execute native pending transactions.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

const APPROVAL_SECONDS: u64 = 120;
const MAX_SOURCES: usize = 16;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Source {
    pub kind: String,
    pub id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub source: Source,
    pub label: String,
    pub network: String,
    pub physical_id: String,
    pub read_wallet_id: String,
    pub signing_wallet_id: String,
    pub owner_registration_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub account_index: u32,
    pub balance_atomic: String,
    pub unlocked_balance_atomic: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub error_code: String,
    pub amount_atomic: String,
    pub fee_atomic: String,
    #[serde(deserialize_with = "number_or_string")]
    pub tx_count: u64,
    pub tx_ids: Vec<String>,
}
fn number_or_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    v.as_u64()
        .or_else(|| v.as_str()?.parse().ok())
        .ok_or_else(|| serde::de::Error::custom("invalid transaction count"))
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransactionDetail {
    pub hash: String,
    pub amount_atomic: String,
    pub fee_atomic: String,
    pub subaddress_account: u32,
    #[serde(default)]
    pub subaddress_indices: Vec<u32>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReport {
    pub status: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub broadcasted_tx_ids: Vec<String>,
    #[serde(default)]
    pub uncertain_tx_ids: Vec<String>,
    #[serde(default)]
    pub remaining_tx_ids: Vec<String>,
    #[serde(default)]
    pub broadcasted_transactions: Vec<TransactionDetail>,
    #[serde(default)]
    pub broadcasted_amount_atomic: Option<String>,
    #[serde(default)]
    pub broadcasted_fee_atomic: Option<String>,
    #[serde(default)]
    pub broadcasted_totals_known: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub binding_index: usize,
    pub account_index: u32,
    pub prepared: Prepared,
    #[serde(default)]
    pub broadcasted: Vec<TransactionDetail>,
    #[serde(default)]
    pub known_amount_atomic: Option<String>,
    #[serde(default)]
    pub known_fee_atomic: Option<String>,
    #[serde(default)]
    pub totals_unknown: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub address: String,
    pub network: String,
    pub bindings: Vec<Binding>,
    pub members: Vec<Member>,
    pub phase: String,
    pub error: Option<String>,
    pub expires_at: u64,
    pub claim: u64,
    #[serde(default)]
    pub broadcast_attempted: bool,
    /// Native pending handles are owned only by this process. Never restore
    /// ownership from the encrypted receipt after restarting the application.
    #[serde(skip)]
    pub live_pending: bool,
    pub lease_held: bool,
    #[serde(default)]
    pub broadcasted_tx_ids: Vec<String>,
    #[serde(default)]
    pub uncertain_tx_ids: Vec<String>,
}
impl Plan {
    pub fn financials(&self) -> Result<(u64, u64, u64, Vec<String>), String> {
        if self.bindings.is_empty()
            || self.members.is_empty()
            || self.bindings.iter().any(|b| {
                b.network != self.network
                    || b.read_wallet_id.is_empty()
                    || b.signing_wallet_id.is_empty()
            })
        {
            return Err("The payment has no valid bound sources.".to_owned());
        }
        let mut amount = 0u64;
        let mut fee = 0u64;
        let mut hashes = Vec::new();
        let mut unique = HashSet::new();
        let mut accounts = HashSet::new();
        for member in &self.members {
            if member.binding_index >= self.bindings.len()
                || !accounts.insert((member.binding_index, member.account_index))
            {
                return Err("The payment source scope is invalid.".to_owned());
            }
            validate_prepared(&member.prepared)?;
            amount = amount
                .checked_add(atomic(&member.prepared.amount_atomic)?)
                .ok_or_else(|| "Payment amount overflow.".to_owned())?;
            fee = fee
                .checked_add(atomic(&member.prepared.fee_atomic)?)
                .ok_or_else(|| "Payment fee overflow.".to_owned())?;
            for hash in &member.prepared.tx_ids {
                if !unique.insert(hash.clone()) {
                    return Err("Duplicate payment transaction.".to_owned());
                }
                hashes.push(hash.clone());
            }
        }
        let total = amount
            .checked_add(fee)
            .ok_or_else(|| "Payment total overflow.".to_owned())?;
        if self
            .broadcasted_tx_ids
            .iter()
            .any(|id| !unique.contains(id))
            || self
                .uncertain_tx_ids
                .iter()
                .any(|id| !unique.contains(id) || self.broadcasted_tx_ids.contains(id))
        {
            return Err("The payment receipt does not match its prepared transactions.".to_owned());
        }
        Ok((amount, fee, total, hashes))
    }
    fn broadcast_totals(&self) -> Result<(u64, u64), String> {
        let mut amount = 0u64;
        let mut fee = 0u64;
        for member in &self.members {
            let known: Vec<_> = member
                .prepared
                .tx_ids
                .iter()
                .filter(|id| self.broadcasted_tx_ids.contains(id))
                .collect();
            if known.is_empty() {
                continue;
            }
            if member.totals_unknown {
                return Err("The transmitted amount is not yet verified.".to_owned());
            }
            let known_len = known.len();
            let (member_amount, member_fee) = if let (Some(a), Some(f)) =
                (&member.known_amount_atomic, &member.known_fee_atomic)
            {
                (atomic(a)?, atomic(f)?)
            } else if known.len() == member.prepared.tx_ids.len() {
                (
                    atomic(&member.prepared.amount_atomic)?,
                    atomic(&member.prepared.fee_atomic)?,
                )
            } else {
                let mut a = 0u64;
                let mut f = 0u64;
                let mut details = HashSet::new();
                for hash in known {
                    let detail = member
                        .broadcasted
                        .iter()
                        .find(|d| &d.hash == hash)
                        .ok_or_else(|| "The transmitted amount is not yet verified.".to_owned())?;
                    if !details.insert(hash) {
                        return Err("Duplicate transaction detail.".to_owned());
                    }
                    a = a
                        .checked_add(atomic(&detail.amount_atomic)?)
                        .ok_or_else(|| "Receipt amount overflow.".to_owned())?;
                    f = f
                        .checked_add(atomic(&detail.fee_atomic)?)
                        .ok_or_else(|| "Receipt fee overflow.".to_owned())?;
                }
                (a, f)
            };
            if member_amount > atomic(&member.prepared.amount_atomic)?
                || member_fee > atomic(&member.prepared.fee_atomic)?
                || (known_len == member.prepared.tx_ids.len()
                    && (member_amount != atomic(&member.prepared.amount_atomic)?
                        || member_fee != atomic(&member.prepared.fee_atomic)?))
            {
                return Err("The native receipt exceeds its approved amount.".to_owned());
            }
            amount = amount
                .checked_add(member_amount)
                .ok_or_else(|| "Receipt amount overflow.".to_owned())?;
            fee = fee
                .checked_add(member_fee)
                .ok_or_else(|| "Receipt fee overflow.".to_owned())?;
        }
        Ok((amount, fee))
    }
    pub fn attempted(&self) -> bool {
        self.broadcast_attempted
            || !self.broadcasted_tx_ids.is_empty()
            || !self.uncertain_tx_ids.is_empty()
    }
    pub fn public(&self) -> serde_json::Value {
        let (amount, fee, total, tx_ids) = match self.financials() {
            Ok(value) => value,
            Err(error) => {
                return serde_json::json!({"id":self.id,"address":self.address,"sources":self.bindings.iter().map(|b|&b.source).collect::<Vec<_>>(),"phase":self.phase,"status":"error","error":error,"amountAtomic":null,"feeAtomic":null,"totalAtomic":null,"txCount":0,"txIds":[],"broadcastedTxIds":self.broadcasted_tx_ids,"uncertainTxIds":self.uncertain_tx_ids,"remainingTxIds":[],"broadcastAttempted":self.attempted(),"leaseHeld":self.lease_held,"broadcastedAmountAtomic":if self.attempted(){None}else{Some("0")},"broadcastedFeeAtomic":if self.attempted(){None}else{Some("0")},"broadcastedTotalsKnown":!self.attempted()})
            }
        };
        let totals = self.broadcast_totals();
        let remaining: Vec<_> = tx_ids
            .iter()
            .filter(|id| {
                !self.broadcasted_tx_ids.contains(id) && !self.uncertain_tx_ids.contains(id)
            })
            .cloned()
            .collect();
        let status = if !self.uncertain_tx_ids.is_empty()
            || self.phase == "interrupted"
            || totals.is_err()
        {
            "uncertain"
        } else if !self.broadcasted_tx_ids.is_empty()
            && self.broadcasted_tx_ids.len() != tx_ids.len()
        {
            "partial"
        } else if self.phase == "discarded" || self.error.is_some() {
            "error"
        } else {
            "ok"
        };
        serde_json::json!({"id":self.id,"address":self.address,"sources":self.bindings.iter().map(|b|&b.source).collect::<Vec<_>>(),"status":status,"phase":self.phase,"amountAtomic":amount.to_string(),"feeAtomic":fee.to_string(),"totalAtomic":total.to_string(),"txCount":tx_ids.len(),"txIds":tx_ids,"sourceLabels":self.bindings.iter().map(|b|&b.label).collect::<Vec<_>>(),"memberDetails":self.members.iter().map(|m|serde_json::json!({"source":self.bindings[m.binding_index].source,"label":self.bindings[m.binding_index].label,"accountIndex":m.account_index,"amountAtomic":m.prepared.amount_atomic,"feeAtomic":m.prepared.fee_atomic,"txCount":m.prepared.tx_count,"txIds":m.prepared.tx_ids})).collect::<Vec<_>>(),"broadcastAttempted":self.attempted(),"leaseHeld":self.lease_held,"broadcastedTxIds":self.broadcasted_tx_ids,"uncertainTxIds":self.uncertain_tx_ids,"remainingTxIds":remaining,"broadcastedAmountAtomic":totals.as_ref().ok().map(|v|v.0.to_string()),"broadcastedFeeAtomic":totals.as_ref().ok().map(|v|v.1.to_string()),"broadcastedTotalsKnown":totals.is_ok(),"broadcastedAmountsComplete":totals.is_ok(),"error":self.error})
    }
    pub fn terminal(&self) -> bool {
        matches!(
            self.phase.as_str(),
            "complete" | "discarded" | "interrupted"
        )
    }
}

pub fn atomic(s: &str) -> Result<u64, String> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid atomic Monero amount.".to_owned());
    }
    s.parse()
        .map_err(|_| "Monero amount exceeds the supported range.".to_owned())
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "Secure plan identity is unavailable.".to_owned())?;
    Ok(format!("send-plan-{}", hex::encode(bytes)))
}
pub trait Native {
    fn accounts(&mut self, wallet: &str) -> Result<Vec<Account>, String>;
    fn prepare(
        &mut self,
        wallet: &str,
        address: &str,
        amount: &str,
        priority: &str,
        account: u32,
    ) -> Result<Prepared, String>;
    fn discard(&mut self, wallet: &str, pending: &str) -> Result<(), String>;
    fn commit(&mut self, wallet: &str, pending: &str) -> Result<CommitReport, String>;
}
pub trait Journal {
    fn load(&mut self) -> Result<Vec<Plan>, String>;
    fn save(&mut self, plan: &Plan) -> Result<(), String>;
}

#[derive(Default)]
pub struct Store {
    plans: HashMap<String, Plan>,
    next_claim: u64,
}
impl Store {
    pub fn all(&self) -> Vec<Plan> {
        self.plans.values().cloned().collect()
    }
    pub fn get(&self, id: &str) -> Option<Plan> {
        self.plans.get(id).cloned()
    }
    pub fn clear(&mut self) {
        self.plans.clear();
        self.next_claim = self.next_claim.wrapping_add(1);
    }
    pub fn leases_wallet(&self, wallet: &str) -> bool {
        self.plans.values().any(|p| {
            p.lease_held
                && p.bindings
                    .iter()
                    .any(|b| b.read_wallet_id == wallet || b.signing_wallet_id == wallet)
        })
    }
    pub fn active_for(&self, physical: &str) -> Option<Plan> {
        self.plans
            .values()
            .find(|p| p.lease_held && p.bindings.iter().any(|b| b.physical_id == physical))
            .cloned()
    }
    pub fn expired(&self, time: u64) -> Vec<Plan> {
        self.plans
            .values()
            .filter(|p| p.phase == "prepared" && p.expires_at <= time)
            .cloned()
            .collect()
    }
    pub fn reserve(
        &mut self,
        id: String,
        bindings: Vec<Binding>,
        journal: &mut impl Journal,
    ) -> Result<(), String> {
        if bindings.is_empty() || bindings.len() > MAX_SOURCES {
            return Err("Select between one and sixteen wallet sources.".to_owned());
        }
        let keys: HashSet<_> = bindings.iter().map(|b| &b.physical_id).collect();
        if keys.len() != bindings.len() {
            return Err("The selected sources contain the same physical wallet twice.".to_owned());
        }
        let network = &bindings[0].network;
        if bindings.iter().any(|b| b.network != *network) {
            return Err("All payment sources must use the same Monero network.".to_owned());
        }
        if self
            .plans
            .values()
            .any(|p| p.lease_held && p.bindings.iter().any(|b| keys.contains(&b.physical_id)))
        {
            return Err("A payment already reserves this wallet. Discard its review or inspect its receipt first.".to_owned());
        }
        if journal
            .load()?
            .into_iter()
            .map(recovered)
            .any(|p| p.lease_held && p.bindings.iter().any(|b| keys.contains(&b.physical_id)))
        {
            return Err("A previous payment has an unresolved receipt. Check its transaction status before preparing another payment.".to_owned());
        }
        self.plans.insert(
            id.clone(),
            Plan {
                id,
                address: String::new(),
                network: network.clone(),
                bindings,
                members: Vec::new(),
                phase: "preparing".to_owned(),
                error: None,
                expires_at: 0,
                claim: 0,
                broadcast_attempted: false,
                live_pending: true,
                lease_held: true,
                broadcasted_tx_ids: Vec::new(),
                uncertain_tx_ids: Vec::new(),
            },
        );
        Ok(())
    }
    pub fn publish(&mut self, mut plan: Plan, time: u64) -> Result<Plan, String> {
        if self
            .plans
            .get(&plan.id)
            .is_none_or(|p| p.phase != "preparing")
        {
            return Err("The app session changed while preparing the payment.".to_owned());
        }
        plan.financials()?;
        plan.expires_at = time.saturating_add(APPROVAL_SECONDS);
        plan.phase = "prepared".to_owned();
        self.plans.insert(plan.id.clone(), plan.clone());
        Ok(plan)
    }
    pub fn replace(&mut self, plan: Plan) {
        self.plans.insert(plan.id.clone(), plan);
    }
    pub fn abandon(&mut self, id: &str) {
        self.plans.remove(id);
    }
    pub fn claim(&mut self, id: &str, time: u64) -> Result<(Plan, u64), String> {
        let plan = self.plans.get_mut(id).ok_or_else(|| {
            "This payment review is no longer executable. Check its saved receipt.".to_owned()
        })?;
        if plan.phase != "prepared" || plan.expires_at <= time {
            return Err(
                "This payment is already being processed, expired, or was already used.".to_owned(),
            );
        }
        plan.financials()?;
        self.next_claim = self.next_claim.wrapping_add(1);
        plan.claim = self.next_claim;
        plan.phase = "authorizing".to_owned();
        Ok((plan.clone(), plan.claim))
    }
    pub fn validate_claim(&self, id: &str, claim: u64, time: u64) -> Result<Plan, String> {
        let plan = self
            .plans
            .get(id)
            .ok_or_else(|| "The app session changed. This payment was not sent.".to_owned())?;
        if plan.phase != "authorizing" || plan.claim != claim || plan.expires_at <= time {
            return Err("This payment approval is no longer current. Nothing was sent.".to_owned());
        }
        plan.financials()?;
        Ok(plan.clone())
    }
    pub fn release_claim(&mut self, id: &str, claim: u64) {
        if let Some(p) = self.plans.get_mut(id) {
            if p.phase == "authorizing" && p.claim == claim {
                p.phase = "prepared".to_owned();
            }
        }
    }
    pub fn start(&mut self, id: &str, claim: u64, time: u64) -> Result<Plan, String> {
        let mut plan = self.validate_claim(id, claim, time)?;
        plan.phase = "broadcasting".to_owned();
        self.replace(plan.clone());
        Ok(plan)
    }
}
fn attempt(
    native: &mut impl Native,
    plan: &mut Plan,
    binding_index: usize,
    account_index: u32,
    amount: &str,
    priority: &str,
) -> Result<Option<usize>, String> {
    let wallet = plan.bindings[binding_index].signing_wallet_id.clone();
    let prepared = native.prepare(&wallet, &plan.address, amount, priority, account_index)?;
    let insufficient = prepared.error_code == "insufficient_funds";
    let ok = prepared.status == "ok";
    let error = prepared.error.clone();
    // Register the native handle before interpreting any financial field.
    // Invalid metadata must not leak a live pending transaction or its lease.
    let index = plan.members.len();
    if ok || !prepared.id.is_empty() {
        plan.members.push(Member {
            binding_index,
            account_index,
            prepared,
            broadcasted: Vec::new(),
            known_amount_atomic: None,
            known_fee_atomic: None,
            totals_unknown: false,
        });
    }
    if !ok {
        if plan.members.len() > index {
            native.discard(&wallet, &plan.members[index].prepared.id)?;
            plan.members.pop();
        }
        return if insufficient {
            Ok(None)
        } else {
            Err(if error.is_empty() {
                "Transaction preparation failed.".to_owned()
            } else {
                error
            })
        };
    }
    validate_prepared(&plan.members[index].prepared)?;
    Ok(Some(index))
}
// Failure returns ownership of every allocated native handle for cleanup.
// Keep that complete plan available even when preparation fails halfway.
#[allow(clippy::result_large_err)]
pub fn prepare(
    native: &mut impl Native,
    mut plan: Plan,
    address: String,
    amount: &str,
    priority: &str,
) -> Result<Plan, (String, Plan)> {
    plan.address = address;
    let target = if amount.is_empty() {
        None
    } else {
        match atomic(amount) {
            Ok(v) if v > 0 => Some(v),
            _ => return Err(("Enter a positive Monero amount.".to_owned(), plan)),
        }
    };
    let result = (|| -> Result<(), String> {
        let mut accounts = Vec::new();
        for (binding_index, binding) in plan.bindings.iter().enumerate() {
            let mut seen = HashSet::new();
            for account in native.accounts(&binding.signing_wallet_id)? {
                if !seen.insert(account.account_index) {
                    return Err("The native wallet returned duplicate accounts.".to_owned());
                }
                let available = atomic(&account.unlocked_balance_atomic)?;
                let total = atomic(&account.balance_atomic)?;
                if available > total {
                    return Err("The native wallet balance is inconsistent.".to_owned());
                }
                if available > 0 {
                    accounts.push((available, binding_index, account.account_index));
                }
            }
        }
        accounts.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let mut remaining = target.unwrap_or(0);
        for (available, binding_index, account_index) in accounts {
            if target.is_some() && remaining == 0 {
                break;
            }
            let exact = if target.is_none() || remaining >= available {
                String::new()
            } else {
                remaining.to_string()
            };
            let mut index = match attempt(
                native,
                &mut plan,
                binding_index,
                account_index,
                &exact,
                priority,
            )? {
                Some(index) => index,
                None if !exact.is_empty() => match attempt(
                    native,
                    &mut plan,
                    binding_index,
                    account_index,
                    "",
                    priority,
                )? {
                    Some(index) => index,
                    None => continue,
                },
                None => continue,
            };
            let mut contribution = atomic(&plan.members[index].prepared.amount_atomic)?;
            if target.is_some() && contribution > remaining {
                let fee = atomic(&plan.members[index].prepared.fee_atomic)?;
                native.discard(
                    &plan.bindings[binding_index].signing_wallet_id,
                    &plan.members[index].prepared.id,
                )?;
                plan.members.pop();
                let smaller = remaining
                    .saturating_sub(fee.max(1))
                    .min(available.saturating_sub(fee.saturating_mul(2)));
                if smaller == 0 {
                    continue;
                }
                index = match attempt(
                    native,
                    &mut plan,
                    binding_index,
                    account_index,
                    &smaller.to_string(),
                    priority,
                )? {
                    Some(index) => index,
                    None => continue,
                };
                contribution = atomic(&plan.members[index].prepared.amount_atomic)?;
            }
            let fee = atomic(&plan.members[index].prepared.fee_atomic)?;
            if contribution.checked_add(fee).is_none_or(|v| v > available) {
                return Err("Native payment exceeds its account budget.".to_owned());
            }
            if target.is_some() && contribution > remaining {
                return Err("Native payment exceeds the requested recipient amount.".to_owned());
            }
            if target.is_some() {
                remaining -= contribution;
            }
        }
        if plan.members.is_empty() || (target.is_some() && remaining != 0) {
            return Err("Insufficient unlocked Monero after the exact network fees.".to_owned());
        }
        plan.financials()?;
        Ok(())
    })();
    result.map(|_| plan.clone()).map_err(|e| (e, plan))
}

fn validate_prepared(p: &Prepared) -> Result<(), String> {
    if p.status != "ok"
        || p.id.is_empty()
        || atomic(&p.amount_atomic)? == 0
        || p.tx_count == 0
        || p.tx_count as usize != p.tx_ids.len()
        || p.tx_ids.iter().any(|id| !valid_hash(id))
        || p.tx_ids.iter().collect::<HashSet<_>>().len() != p.tx_ids.len()
    {
        return Err("The native transaction review is invalid.".to_owned());
    }
    atomic(&p.fee_atomic)?;
    Ok(())
}
pub fn discard(native: &mut impl Native, plan: &mut Plan) -> Result<(), String> {
    if !plan.broadcasted_tx_ids.is_empty()
        || !plan.uncertain_tx_ids.is_empty()
        || matches!(
            plan.phase.as_str(),
            "broadcasting" | "authorizing" | "interrupted"
        )
    {
        return Err(
            "An attempted payment cannot be discarded. Check its transaction receipt.".to_owned(),
        );
    }
    for member in &plan.members {
        native.discard(
            &plan.bindings[member.binding_index].signing_wallet_id,
            &member.prepared.id,
        )?;
    }
    plan.phase = "discarded".to_owned();
    plan.lease_held = false;
    Ok(())
}
pub fn commit(
    native: &mut impl Native,
    journal: &mut impl Journal,
    plan: &mut Plan,
    mut checkpoint: impl FnMut(&Plan) -> Result<(), String>,
) {
    for index in 0..plan.members.len() {
        if let Err(error) = checkpoint(plan) {
            plan.error = Some(error);
            break;
        }
        let ids = plan.members[index].prepared.tx_ids.clone();
        // This durable write precedes every network attempt. A crash after
        // remote acceptance therefore leaves an uncertain, non-executable
        // receipt rather than silently permitting a fresh payment.
        let previously_attempted = plan.broadcast_attempted;
        plan.broadcast_attempted = true;
        plan.uncertain_tx_ids = ids.clone();
        if let Err(error) = journal.save(plan) {
            plan.broadcast_attempted = previously_attempted;
            plan.uncertain_tx_ids.clear();
            plan.error = Some(format!(
                "Secure receipt could not be saved; no further transaction was sent. {error}"
            ));
            break;
        }
        let member = &plan.members[index];
        let result = native.commit(
            &plan.bindings[member.binding_index].signing_wallet_id,
            &member.prepared.id,
        );
        match result {
            Err(_) => {
                plan.error=Some("The node response is uncertain. Do not send this payment again; inspect this receipt.".to_owned());
            }
            Ok(report) => {
                let expected: BTreeSet<_> = ids.iter().cloned().collect();
                let known: BTreeSet<_> = report.broadcasted_tx_ids.iter().cloned().collect();
                let uncertain: BTreeSet<_> = report.uncertain_tx_ids.iter().cloned().collect();
                let remaining: BTreeSet<_> = report.remaining_tx_ids.iter().cloned().collect();
                let valid = known.is_subset(&expected)
                    && uncertain.is_subset(&expected)
                    && remaining.is_subset(&expected)
                    && known.is_disjoint(&uncertain)
                    && known.is_disjoint(&remaining)
                    && uncertain.is_subset(&remaining)
                    && known.union(&remaining).cloned().collect::<BTreeSet<_>>() == expected;
                let details_valid = report
                    .broadcasted_transactions
                    .iter()
                    .map(|d| &d.hash)
                    .collect::<HashSet<_>>()
                    .len()
                    == report.broadcasted_transactions.len()
                    && report.broadcasted_transactions.iter().all(|d| {
                        known.contains(&d.hash)
                            && d.subaddress_account == plan.members[index].account_index
                            && atomic(&d.amount_atomic).is_ok()
                            && atomic(&d.fee_atomic).is_ok()
                    });
                if !valid {
                    plan.error=Some("The native broadcast receipt could not be verified. Check transaction status before any new payment.".to_owned());
                } else {
                    for id in known {
                        if !plan.broadcasted_tx_ids.contains(&id) {
                            plan.broadcasted_tx_ids.push(id);
                        }
                    }
                    plan.uncertain_tx_ids = uncertain.into_iter().collect();
                    if details_valid {
                        plan.members[index].broadcasted = report.broadcasted_transactions;
                    } else {
                        plan.error=Some("Per-transaction receipt details need verification; known transaction IDs are retained.".to_owned());
                    }
                    if report.broadcasted_totals_known
                        && report
                            .broadcasted_amount_atomic
                            .as_deref()
                            .is_some_and(|s| atomic(s).is_ok())
                        && report
                            .broadcasted_fee_atomic
                            .as_deref()
                            .is_some_and(|s| atomic(s).is_ok())
                    {
                        plan.members[index].known_amount_atomic = report.broadcasted_amount_atomic;
                        plan.members[index].known_fee_atomic = report.broadcasted_fee_atomic;
                    } else if !report.broadcasted_tx_ids.is_empty() {
                        plan.members[index].totals_unknown = true;
                    }
                    if report.status != "ok"
                        || !plan.uncertain_tx_ids.is_empty()
                        || !remaining.is_empty()
                        || ids.iter().any(|id| !plan.broadcasted_tx_ids.contains(id))
                    {
                        plan.error = Some(if report.error.is_empty() {
                            "Only part of this payment was transmitted. Inspect its receipt before continuing.".to_owned()
                        } else {
                            report.error
                        });
                    }
                }
            }
        }
        if let Err(error) = plan.broadcast_totals() {
            plan.error = Some(format!(
                "Native transmitted totals need verification. {error}"
            ));
            plan.lease_held = true;
        }
        if let Err(error) = checkpoint(plan) {
            plan.error.get_or_insert(error);
        }
        if let Err(error) = journal.save(plan) {
            plan.error=Some(format!("The transmission receipt could not be saved. Known transaction IDs are shown; do not send again. {error}"));
            plan.lease_held = true;
            plan.phase = "interrupted".to_owned();
            return;
        }
        if plan.error.is_some() {
            break;
        }
    }
    plan.phase = "complete".to_owned();
    if plan.uncertain_tx_ids.is_empty() && plan.broadcast_totals().is_ok() {
        let mut cleanup_ok = true;
        for member in &plan.members {
            if member
                .prepared
                .tx_ids
                .iter()
                .all(|id| plan.broadcasted_tx_ids.contains(id))
            {
                continue;
            }
            if native
                .discard(
                    &plan.bindings[member.binding_index].signing_wallet_id,
                    &member.prepared.id,
                )
                .is_err()
            {
                cleanup_ok = false;
            }
        }
        plan.lease_held = !cleanup_ok;
    }
    if let Err(error) = journal.save(plan) {
        plan.error = Some(format!(
            "Receipt persistence needs attention; do not repeat the payment. {error}"
        ));
        plan.lease_held = true;
        plan.phase = "interrupted".to_owned();
    }
}
pub fn recovered(mut plan: Plan) -> Plan {
    plan.live_pending = false;
    if !plan.attempted() {
        plan.phase = "discarded".to_owned();
        plan.lease_held = false;
        plan.error=Some("This saved payment was not transmitted. Its previous native review is no longer executable.".to_owned());
    } else if plan.lease_held || plan.phase == "broadcasting" {
        plan.phase = "interrupted".to_owned();
        plan.lease_held = true;
        plan.error=Some("This is a saved receipt from an earlier app session. It cannot send again. Check the listed transaction IDs.".to_owned());
    }
    plan
}

/// Evidence comes exclusively from the native wallet history, never from the
/// application's optimistic pending-outgoing overlay or a renderer payload.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTransaction {
    pub hash: String,
    pub direction: String,
    pub failed: bool,
    pub pending: bool,
    pub block_height: String,
    pub amount_atomic: Option<String>,
    pub fee_atomic: Option<String>,
    pub subaddress_account: Option<u32>,
    #[serde(default)]
    pub subaddress_indices: Vec<u32>,
}
#[derive(Clone, Debug)]
pub struct HistoryEvidence {
    pub physical_id: String,
    pub network: String,
    pub transactions: Vec<HistoryTransaction>,
}
fn confirmed_outgoing<'a>(
    proof: &'a HistoryEvidence,
    hash: &str,
    account: u32,
) -> Option<&'a HistoryTransaction> {
    proof.transactions.iter().find(|tx| {
        tx.hash.eq_ignore_ascii_case(hash)
            && tx.direction == "out"
            && !tx.failed
            && !tx.pending
            && tx.subaddress_account == Some(account)
            && atomic(&tx.block_height).is_ok_and(|height| height > 0)
    })
}
/// Promote only positive, confirmed native evidence. Missing hashes, errors,
/// incoming transactions and unconfirmed/local entries prove nothing negative.
/// This function has no native relay/discard capability and cannot release a
/// source lease by itself; the host must complete owned-handle cleanup and
/// persist the reconciled receipt before allowing a new payment.
pub fn reconcile_positive(plan: &mut Plan, evidence: &[HistoryEvidence]) -> Result<bool, String> {
    if !matches!(plan.phase.as_str(), "complete" | "interrupted") {
        return Ok(false);
    }
    plan.financials()?;
    let mut changed = false;
    for member in &mut plan.members {
        let binding = &plan.bindings[member.binding_index];
        let Some(proof) = evidence.iter().find(|proof| {
            proof.physical_id == binding.physical_id && proof.network == binding.network
        }) else {
            continue;
        };
        let approved_amount = atomic(&member.prepared.amount_atomic)?;
        let approved_fee = atomic(&member.prepared.fee_atomic)?;
        let mut promoted = false;
        for hash in &member.prepared.tx_ids {
            if !plan.uncertain_tx_ids.contains(hash) {
                continue;
            }
            let Some(tx) = confirmed_outgoing(proof, hash, member.account_index) else {
                continue;
            };
            plan.uncertain_tx_ids.retain(|old| old != hash);
            if !plan.broadcasted_tx_ids.contains(hash) {
                plan.broadcasted_tx_ids.push(hash.clone());
            }
            if let (Some(amount), Some(fee)) = (&tx.amount_atomic, &tx.fee_atomic) {
                if atomic(amount).is_ok_and(|v| v > 0 && v <= approved_amount)
                    && atomic(fee).is_ok_and(|v| v <= approved_fee)
                {
                    member.broadcasted.retain(|old| old.hash != *hash);
                    member.broadcasted.push(TransactionDetail {
                        hash: hash.clone(),
                        amount_atomic: amount.clone(),
                        fee_atomic: fee.clone(),
                        subaddress_account: member.account_index,
                        subaddress_indices: tx.subaddress_indices.clone(),
                    });
                }
            }
            promoted = true;
            changed = true;
        }
        let known = member
            .prepared
            .tx_ids
            .iter()
            .filter(|id| plan.broadcasted_tx_ids.contains(id))
            .collect::<Vec<_>>();
        let all_known = known.len() == member.prepared.tx_ids.len();
        let all_confirmed = all_known
            && known
                .iter()
                .all(|id| confirmed_outgoing(proof, id, member.account_index).is_some());
        if all_known && (promoted || all_confirmed) {
            if member.totals_unknown
                || member.known_amount_atomic.as_ref() != Some(&member.prepared.amount_atomic)
                || member.known_fee_atomic.as_ref() != Some(&member.prepared.fee_atomic)
            {
                changed = true;
            }
            member.known_amount_atomic = Some(member.prepared.amount_atomic.clone());
            member.known_fee_atomic = Some(member.prepared.fee_atomic.clone());
            member.totals_unknown = false;
        } else if promoted {
            let mut amount = 0u64;
            let mut fee = 0u64;
            let mut complete = true;
            for hash in known {
                if let Some(detail) = member.broadcasted.iter().find(|d| &d.hash == hash) {
                    amount = amount
                        .checked_add(atomic(&detail.amount_atomic)?)
                        .ok_or_else(|| "Native history amount overflow.".to_owned())?;
                    fee = fee
                        .checked_add(atomic(&detail.fee_atomic)?)
                        .ok_or_else(|| "Native history fee overflow.".to_owned())?;
                } else {
                    complete = false;
                }
            }
            member.known_amount_atomic = complete.then(|| amount.to_string());
            member.known_fee_atomic = complete.then(|| fee.to_string());
            member.totals_unknown = !complete;
        }
    }
    if changed && plan.uncertain_tx_ids.is_empty() {
        let all_known = plan
            .members
            .iter()
            .flat_map(|m| &m.prepared.tx_ids)
            .all(|id| plan.broadcasted_tx_ids.contains(id));
        plan.error = if all_known {
            None
        } else {
            Some("Confirmed transaction IDs were verified. Remaining payment parts were not sent; no retry was performed.".to_owned())
        };
    }
    Ok(changed)
}

#[cfg(test)]
#[path = "send_plan_tests.rs"]
mod tests;
