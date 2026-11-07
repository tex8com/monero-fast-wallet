//! Trusted native adapter for the shared payment planner. This module never
//! logs payment payloads and never accepts a renderer-provided authorization.
use crate::send_plan::{self as core, *};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
#[repr(C)]
pub struct MfwSendPlanHostV1 {
    pub struct_size: u32,
    pub user_data: *mut c_void,
    pub call:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_char>,
    pub release: Option<unsafe extern "C" fn(*mut c_void, *mut c_char)>,
}
struct Context {
    store: Mutex<Store>,
    epoch: u64,
    started: Instant,
}
impl Context {
    fn time(&self) -> u64 {
        self.epoch.saturating_add(self.started.elapsed().as_secs())
    }
}
#[derive(Clone, Copy)]
struct Host<'a>(&'a MfwSendPlanHostV1);
impl Host<'_> {
    fn call<T: DeserializeOwned>(&self, operation: &str, input: Value) -> Result<T, String> {
        let operation = CString::new(operation).map_err(|_| "Invalid native operation.")?;
        let input = CString::new(input.to_string()).map_err(|_| "Invalid native request.")?;
        // The header requires valid owned, NUL-terminated callback results and
        // forbids retaining this per-call native host or reentering its context.
        let raw = unsafe {
            self.0
                .call
                .ok_or("Native payment adapter is unavailable.")?(
                self.0.user_data,
                operation.as_ptr(),
                input.as_ptr(),
            )
        };
        if raw.is_null() {
            return Err("Native payment adapter returned no result.".to_owned());
        }
        let result = unsafe {
            let bytes = CStr::from_ptr(raw).to_bytes();
            if bytes.len() > MAX_JSON_BYTES {
                Err("Native payment response is too large.".to_owned())
            } else {
                serde_json::from_slice::<Value>(bytes)
                    .map_err(|_| "Native payment response is invalid.".to_owned())
            }
        };
        unsafe {
            self.0
                .release
                .ok_or("Native payment adapter cannot release its response.")?(
                self.0.user_data,
                raw,
            )
        };
        let envelope = result?;
        if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(envelope
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Native payment operation failed.")
                .to_owned());
        }
        serde_json::from_value(envelope.get("value").cloned().unwrap_or(Value::Null))
            .map_err(|_| "Native payment value has an invalid shape.".to_owned())
    }
    fn authorized(&self) -> Result<(), String> {
        if self.call::<bool>("authorization.check", Value::Null)? {
            Ok(())
        } else {
            Err("The native app session is locked. No further transaction was sent.".to_owned())
        }
    }
    fn validate(&self, plan: &Plan) -> Result<(), String> {
        self.authorized()?;
        plan.financials()?;
        for binding in &plan.bindings {
            self.call::<Value>("validate", json!(binding))?;
        }
        Ok(())
    }
}
struct NativeAdapter<'a>(Host<'a>);
impl Native for NativeAdapter<'_> {
    fn accounts(&mut self, wallet: &str) -> Result<Vec<Account>, String> {
        self.0.call("accounts", json!({"walletId":wallet}))
    }
    fn prepare(
        &mut self,
        wallet: &str,
        address: &str,
        amount: &str,
        priority: &str,
        account: u32,
    ) -> Result<Prepared, String> {
        self.0.authorized()?;
        self.0.call("prepare", json!({"walletId":wallet,"address":address,"amountAtomic":amount,"priority":priority,"accountIndex":account}))
    }
    fn discard(&mut self, wallet: &str, pending: &str) -> Result<(), String> {
        self.0
            .call::<Value>("discard", json!({"walletId":wallet,"pendingId":pending}))
            .map(|_| ())
    }
    fn commit(&mut self, wallet: &str, pending: &str) -> Result<CommitReport, String> {
        self.0.authorized()?;
        self.0
            .call("commit", json!({"walletId":wallet,"pendingId":pending}))
    }
}
struct NativeJournal<'a>(Host<'a>);
impl Journal for NativeJournal<'_> {
    fn load(&mut self) -> Result<Vec<Plan>, String> {
        self.0.call("journal.load", Value::Null)
    }
    fn save(&mut self, plan: &Plan) -> Result<(), String> {
        let mut plans = self.load()?;
        plans.retain(|p| p.id != plan.id);
        plans.push(plan.clone());
        while plans.len() > 64 {
            let index = plans
                .iter()
                .position(|p| !p.lease_held && p.uncertain_tx_ids.is_empty())
                .ok_or("Resolve pending payment receipts before creating more payments.")?;
            plans.remove(index);
        }
        self.0
            .call::<Value>("journal.save", json!(plans))
            .map(|_| ())
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    #[serde(rename_all = "camelCase")]
    Adopt {
        binding: Box<Binding>,
        account_index: u32,
        prepared: Box<Prepared>,
        address: String,
    },
    #[serde(rename_all = "camelCase")]
    Prepare {
        bindings: Vec<Binding>,
        address: String,
        amount_atomic: String,
        priority: String,
    },
    #[serde(rename_all = "camelCase")]
    Claim {
        plan_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Commit {
        plan_id: String,
        claim_token: String,
    },
    #[serde(rename_all = "camelCase")]
    Release {
        plan_id: String,
        claim_token: String,
    },
    #[serde(rename_all = "camelCase")]
    Status {
        plan_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Discard {
        plan_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Leases {
        wallet_id: String,
        physical_id: String,
    },
    List,
    Invalidate,
}
fn receipt(store: &Store, journal: &mut impl Journal, id: &str) -> Result<Plan, String> {
    if let Some(plan) = store.get(id) {
        return Ok(plan);
    }
    journal
        .load()?
        .into_iter()
        .find(|p| p.id == id)
        .map(core::recovered)
        .ok_or_else(|| {
            "The payment receipt was not found. Nothing was sent by this request.".to_owned()
        })
}
fn persist_or_hold(
    store: &mut Store,
    journal: &mut impl Journal,
    plan: &mut Plan,
) -> Result<(), String> {
    if let Err(error) = journal.save(plan) {
        plan.lease_held = true;
        plan.error = Some(format!(
            "The payment receipt could not be saved. Do not send again. {error}"
        ));
        if plan.attempted() {
            plan.phase = "interrupted".to_owned();
        }
        store.replace(plan.clone());
        return Err(error);
    }
    store.replace(plan.clone());
    Ok(())
}
fn dispatch(context: &Context, host: Host<'_>, command: Command) -> Result<Value, String> {
    let mut store = context
        .store
        .lock()
        .map_err(|_| "Payment state needs recovery; inspect its saved receipt.")?;
    let mut native = NativeAdapter(host);
    let mut journal = NativeJournal(host);
    // Invalidation must work after the platform has cleared authorization.
    // Dispose only owned, unattempted handles. Never forget live pointers or
    // uncertain receipts merely because the app was locked. The locked vault
    // need not be written: saved unattempted reviews recover as non-executable;
    // attempted reviews already have their durable pre-network marker.
    if matches!(command, Command::Invalidate) {
        for mut plan in store.all() {
            plan.claim = 0;
            if !plan.attempted() && plan.live_pending {
                // This context is exclusively locked and its private claim has
                // just been revoked. The former authorization cannot race a
                // commit, so its unattempted handles may now be cancelled.
                if matches!(
                    plan.phase.as_str(),
                    "authorizing" | "broadcasting" | "interrupted"
                ) {
                    plan.phase = "prepared".to_owned();
                }
                if let Err(error) = core::discard(&mut native, &mut plan) {
                    plan.phase = "cleanup_failed".to_owned();
                    plan.lease_held = true;
                    plan.error = Some(error);
                }
            } else if plan.attempted() && !plan.terminal() {
                plan.phase = "interrupted".to_owned();
                plan.lease_held = true;
            }
            store.replace(plan);
        }
        return Ok(Value::Null);
    }
    host.authorized()?;
    match command {
        Command::Adopt {
            binding,
            account_index,
            prepared,
            address,
        } => {
            // Only the trusted native adapter can adopt a pending transaction
            // from its own legacy review tracker. It supplies the unchanged
            // native request/preview, never renderer financial metadata.
            let id = core::new_id()?;
            store.reserve(id.clone(), vec![*binding], &mut journal)?;
            let mut plan = store
                .get(&id)
                .ok_or("Legacy payment reservation was lost.")?;
            plan.address = address;
            plan.members.push(Member {
                binding_index: 0,
                account_index,
                prepared: *prepared,
                broadcasted: Vec::new(),
                known_amount_atomic: None,
                known_fee_atomic: None,
                totals_unknown: false,
            });
            let prepared = (|| {
                if plan.address.is_empty() {
                    return Err("Native payment recipient is missing.".to_owned());
                }
                host.validate(&plan)?;
                let published = store.publish(plan.clone(), context.time())?;
                journal.save(&published)?;
                Ok(published)
            })();
            match prepared {
                Ok(published) => {
                    let public = published.public();
                    store.replace(published);
                    Ok(public)
                }
                Err(error) => {
                    if core::discard(&mut native, &mut plan).is_err() {
                        plan.phase = "cleanup_failed".to_owned();
                        plan.lease_held = true;
                    }
                    plan.error = Some(error.clone());
                    store.replace(plan);
                    Err(error)
                }
            }
        }
        Command::List => {
            let mut plans = journal
                .load()?
                .into_iter()
                .map(core::recovered)
                .map(|p| (p.id.clone(), p))
                .collect::<std::collections::BTreeMap<_, _>>();
            for plan in store.all() {
                plans.insert(plan.id.clone(), plan);
            }
            let mut plans = plans.into_values().collect::<Vec<_>>();
            plans.sort_by(|a, b| {
                b.expires_at
                    .cmp(&a.expires_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
            Ok(json!(plans.iter().map(Plan::public).collect::<Vec<_>>()))
        }
        Command::Prepare {
            bindings,
            address,
            amount_atomic,
            priority,
        } => {
            if address.is_empty()
                || !matches!(
                    priority.as_str(),
                    "low" | "default" | "medium" | "high" | "highest"
                )
            {
                return Err("A valid native recipient and priority are required.".to_owned());
            }
            for binding in &bindings {
                host.call::<Value>("validate", json!(binding))?;
            }
            for mut old in store.expired(context.time()) {
                core::discard(&mut native, &mut old)?;
                persist_or_hold(&mut store, &mut journal, &mut old)?;
            }
            let id = core::new_id()?;
            store.reserve(id.clone(), bindings, &mut journal)?;
            let initial = store.get(&id).ok_or("Payment reservation was lost.")?;
            match core::prepare(&mut native, initial, address, &amount_atomic, &priority) {
                Ok(mut plan) => {
                    if let Err(error) = host.validate(&plan) {
                        if core::discard(&mut native, &mut plan).is_err() {
                            plan.phase = "cleanup_failed".to_owned();
                            plan.lease_held = true;
                        }
                        plan.error = Some(error.clone());
                        store.replace(plan);
                        return Err(error);
                    }
                    let mut published = store.publish(plan, context.time())?;
                    if let Err(error) = journal.save(&published) {
                        if core::discard(&mut native, &mut published).is_err() {
                            published.phase = "cleanup_failed".to_owned();
                            published.lease_held = true;
                        }
                        published.error = Some(error.clone());
                        store.replace(published);
                        return Err(error);
                    }
                    store.replace(published.clone());
                    Ok(published.public())
                }
                Err((error, mut failed)) => {
                    if core::discard(&mut native, &mut failed).is_err() {
                        failed.phase = "cleanup_failed".to_owned();
                        failed.lease_held = true;
                        failed.error = Some(error.clone());
                        let _ = journal.save(&failed);
                        store.replace(failed);
                    } else {
                        store.abandon(&id);
                    }
                    Err(error)
                }
            }
        }
        Command::Claim { plan_id } => {
            let current = receipt(&store, &mut journal, &plan_id)?;
            if current.terminal() {
                return Ok(json!({"plan":current.public(),"claimToken":""}));
            }
            host.validate(&current)?;
            let (plan, token) = store.claim(&plan_id, context.time())?;
            if let Err(error) = journal.save(&plan) {
                store.release_claim(&plan_id, token);
                return Err(error);
            }
            Ok(json!({"plan":plan.public(),"claimToken":token.to_string()}))
        }
        Command::Release {
            plan_id,
            claim_token,
        } => {
            let token = claim_token
                .parse()
                .map_err(|_| "Invalid native payment approval.")?;
            store.release_claim(&plan_id, token);
            if let Some(mut plan) = store.get(&plan_id) {
                persist_or_hold(&mut store, &mut journal, &mut plan)?;
            }
            Ok(Value::Null)
        }
        Command::Commit {
            plan_id,
            claim_token,
        } => {
            let current = receipt(&store, &mut journal, &plan_id)?;
            if current.terminal() {
                return Ok(current.public());
            }
            let token = claim_token
                .parse()
                .map_err(|_| "Invalid native payment approval.")?;
            let approved = store.validate_claim(&plan_id, token, context.time())?;
            host.validate(&approved)?;
            let mut plan = store.start(&plan_id, token, context.time())?;
            core::commit(&mut native, &mut journal, &mut plan, |current| {
                host.validate(current)?;
                let saved = store
                    .get(&current.id)
                    .ok_or("The native app session changed. No further transaction was sent.")?;
                if saved.phase != "broadcasting" || saved.claim != token {
                    return Err("Payment execution is no longer current.".to_owned());
                }
                store.replace(current.clone());
                Ok(())
            });
            // core::commit retains exact IDs and uncertainty even on journal,
            // network, or session failures; never convert that into a retry.
            let public = plan.public();
            store.replace(plan);
            Ok(public)
        }
        Command::Discard { plan_id } => {
            let mut plan = receipt(&store, &mut journal, &plan_id)?;
            if plan.attempted() {
                return Err(
                    "An attempted payment cannot be discarded or retried. Inspect its receipt."
                        .to_owned(),
                );
            }
            if plan.live_pending {
                core::discard(&mut native, &mut plan)?;
            } else {
                plan.phase = "discarded".to_owned();
                plan.lease_held = false;
            }
            persist_or_hold(&mut store, &mut journal, &mut plan)?;
            Ok(Value::Null)
        }
        Command::Status { plan_id } => {
            let mut plan = receipt(&store, &mut journal, &plan_id)?;
            if matches!(plan.phase.as_str(), "complete" | "interrupted") {
                let evidence = plan
                    .bindings
                    .iter()
                    .filter_map(|binding| {
                        host.call::<Vec<HistoryTransaction>>("history", json!(binding))
                            .ok()
                            .map(|transactions| HistoryEvidence {
                                physical_id: binding.physical_id.clone(),
                                network: binding.network.clone(),
                                transactions,
                            })
                    })
                    .collect::<Vec<_>>();
                match core::reconcile_positive(&mut plan, &evidence) {
                    Ok(_) => (),
                    Err(error) => {
                        plan.error = Some(error);
                        plan.lease_held = true;
                    }
                }
                if plan.lease_held
                    && plan.uncertain_tx_ids.is_empty()
                    && plan.public()["broadcastedTotalsKnown"] == true
                {
                    let mut clean = true;
                    if plan.live_pending {
                        for member in &plan.members {
                            let binding = &plan.bindings[member.binding_index];
                            if host.call::<Value>("validate", json!(binding)).is_err()
                                || native
                                    .discard(&binding.signing_wallet_id, &member.prepared.id)
                                    .is_err()
                            {
                                clean = false;
                            }
                        }
                    }
                    plan.lease_held = !clean;
                }
                if let Err(error) = persist_or_hold(&mut store, &mut journal, &mut plan) {
                    plan.error=Some(format!("The verified receipt could not be saved. No payment was sent by this status check. {error}"));
                    store.replace(plan.clone());
                }
            }
            Ok(plan.public())
        }
        Command::Leases {
            wallet_id,
            physical_id,
        } => {
            let saved =
                journal.load()?.into_iter().map(core::recovered).any(|p| {
                    p.lease_held && p.bindings.iter().any(|b| b.physical_id == physical_id)
                });
            Ok(json!(
                store.leases_wallet(&wallet_id)
                    || store.active_for(&physical_id).is_some()
                    || saved
            ))
        }
        Command::Invalidate => unreachable!(),
    }
}
fn output(value: Result<Value, String>) -> *mut c_char {
    let envelope = match value {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    CString::new(envelope.to_string())
        .expect("JSON encoding cannot contain literal NUL")
        .into_raw()
}
#[no_mangle]
pub extern "C" fn mfw_send_plan_context_create_v1() -> *mut c_void {
    Box::into_raw(Box::new(Context {
        store: Mutex::new(Store::default()),
        epoch: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        started: Instant::now(),
    }))
    .cast()
}
/// # Safety
/// Context must come from create, have no concurrent users, and be freed once.
#[no_mangle]
pub unsafe extern "C" fn mfw_send_plan_context_destroy_v1(context: *mut c_void) {
    if !context.is_null() {
        drop(Box::from_raw(context.cast::<Context>()));
    }
}
/// # Safety
/// All pointers and callbacks must meet the owned synchronous header contract.
#[no_mangle]
pub unsafe extern "C" fn mfw_send_plan_execute_v1(
    context: *mut c_void,
    host: *const MfwSendPlanHostV1,
    command_json: *const c_char,
) -> *mut c_char {
    output(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let context = context
                .cast::<Context>()
                .as_ref()
                .ok_or("Native payment context is unavailable.")?;
            let host = host.as_ref().ok_or("Native payment host is unavailable.")?;
            if host.struct_size as usize != std::mem::size_of::<MfwSendPlanHostV1>()
                || host.call.is_none()
                || host.release.is_none()
            {
                return Err("Native payment host version is invalid.".to_owned());
            }
            if command_json.is_null() {
                return Err("Payment command is missing.".to_owned());
            }
            let bytes = CStr::from_ptr(command_json).to_bytes();
            if bytes.len() > MAX_JSON_BYTES {
                return Err("Payment command is too large.".to_owned());
            }
            let command = serde_json::from_slice(bytes)
                .map_err(|_| "Payment command is invalid.".to_owned())?;
            dispatch(context, Host(host), command)
        }))
        .unwrap_or_else(|_| {
            Err(
                "Native payment worker stopped. Inspect the saved receipt before continuing."
                    .to_owned(),
            )
        }),
    )
}
/// # Safety
/// Must be called exactly once on an owned execute result, or NULL.
#[no_mangle]
pub unsafe extern "C" fn mfw_send_plan_string_free_v1(result: *mut c_char) {
    if !result.is_null() {
        drop(CString::from_raw(result));
    }
}

/// # Safety
/// Inputs must be valid NUL-terminated trusted native engine UTF-8 strings.
#[no_mangle]
pub unsafe extern "C" fn mfw_send_plan_physical_id_v1(
    network: *const c_char,
    primary_address: *const c_char,
) -> *mut c_char {
    use sha2::{Digest, Sha256};
    output((|| {
        if network.is_null() || primary_address.is_null() {
            return Err("Native wallet identity is unavailable.".to_owned());
        }
        let network = CStr::from_ptr(network)
            .to_str()
            .map_err(|_| "Native wallet network is invalid.")?;
        let address = CStr::from_ptr(primary_address)
            .to_str()
            .map_err(|_| "Native wallet address is invalid.")?;
        if !matches!(network, "mainnet" | "testnet" | "stagenet")
            || !(32..=256).contains(&address.len())
            || !address.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err("Native wallet identity is invalid.".to_owned());
        }
        Ok(json!(format!(
            "wallet:{network}:{}",
            hex::encode(Sha256::digest(address.as_bytes()))
        )))
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fixture {
        journal: Value,
        pending: HashMap<String, Value>,
        calls: Vec<String>,
        serial: u64,
        commits: usize,
        saves: usize,
        released: usize,
        fail_save: Option<usize>,
        fail_all_saves: bool,
        uncertain: bool,
        authorized: bool,
        wal_missing: bool,
        bad_binding: bool,
    }
    impl Fixture {
        fn apply(&mut self, op: &str, input: Value) -> Result<Value, String> {
            self.calls.push(op.to_owned());
            match op {
                "authorization.check" => Ok(json!(self.authorized)),
                "validate" => {
                    if self.bad_binding {
                        Err("Fixture source changed".into())
                    } else {
                        Ok(Value::Null)
                    }
                }
                "journal.load" => Ok(self.journal.clone()),
                "journal.save" => {
                    self.saves += 1;
                    if self.fail_all_saves || self.fail_save == Some(self.saves) {
                        return Err("Fixture durable storage failure".into());
                    }
                    self.journal = input;
                    Ok(Value::Null)
                }
                "accounts" => Ok(json!([
                    {"accountIndex":0,"balanceAtomic":"500","unlockedBalanceAtomic":"500"},
                    {"accountIndex":1,"balanceAtomic":"700","unlockedBalanceAtomic":"700"}
                ])),
                "prepare" => {
                    self.serial += 1;
                    let available = if input["accountIndex"] == 0 { 500 } else { 700 };
                    let amount = if input["amountAtomic"] == "" {
                        available - 20
                    } else {
                        input["amountAtomic"]
                            .as_str()
                            .unwrap()
                            .parse::<u64>()
                            .unwrap()
                    };
                    if amount + 20 > available {
                        return Ok(
                            json!({"id":"","status":"error","error":"Fixture insufficient funds","errorCode":"insufficient_funds","amountAtomic":"0","feeAtomic":"0","txCount":0,"txIds":[]}),
                        );
                    }
                    let id = format!("fixture-pending-{}", self.serial);
                    let prepared = json!({"id":id,"status":"ok","amountAtomic":amount.to_string(),"feeAtomic":"20","txCount":1,"txIds":[format!("{:064x}",self.serial)],"account":input["accountIndex"]});
                    self.pending.insert(id, prepared.clone());
                    Ok(prepared)
                }
                "discard" => {
                    self.pending.remove(input["pendingId"].as_str().unwrap());
                    Ok(Value::Null)
                }
                "commit" => {
                    self.commits += 1;
                    let prepared = self
                        .pending
                        .get(input["pendingId"].as_str().unwrap())
                        .ok_or("Fixture pending missing")?
                        .clone();
                    let hash = prepared["txIds"][0].clone();
                    let saved = self.journal.as_array().unwrap().last().unwrap();
                    if !saved["uncertainTxIds"].as_array().unwrap().contains(&hash) {
                        self.wal_missing = true;
                    }
                    if self.uncertain {
                        return Err("Fixture uncertain transport".into());
                    }
                    Ok(
                        json!({"status":"ok","broadcastedTxIds":[hash],"uncertainTxIds":[],"remainingTxIds":[],"broadcastedTransactions":[{"hash":hash,"amountAtomic":prepared["amountAtomic"],"feeAtomic":"20","subaddressAccount":prepared["account"]}],"broadcastedAmountAtomic":prepared["amountAtomic"],"broadcastedFeeAtomic":"20","broadcastedTotalsKnown":true}),
                    )
                }
                "history" => Ok(json!([])),
                _ => Err("Unexpected fixture operation".into()),
            }
        }
    }
    unsafe extern "C" fn call(
        user: *mut c_void,
        op: *const c_char,
        input: *const c_char,
    ) -> *mut c_char {
        let fixture = &mut *user.cast::<Fixture>();
        let op = CStr::from_ptr(op).to_str().unwrap();
        let input = serde_json::from_slice(CStr::from_ptr(input).to_bytes()).unwrap();
        output(fixture.apply(op, input))
    }
    unsafe extern "C" fn release(user: *mut c_void, result: *mut c_char) {
        (*user.cast::<Fixture>()).released += 1;
        mfw_send_plan_string_free_v1(result);
    }
    struct Harness {
        context: *mut c_void,
        fixture: Box<Fixture>,
    }
    impl Harness {
        fn new() -> Self {
            Self {
                context: mfw_send_plan_context_create_v1(),
                fixture: Box::new(Fixture {
                    journal: json!([]),
                    authorized: true,
                    ..Fixture::default()
                }),
            }
        }
        fn execute(&mut self, command: Value) -> Value {
            let host = MfwSendPlanHostV1 {
                struct_size: std::mem::size_of::<MfwSendPlanHostV1>() as u32,
                user_data: (&mut *self.fixture as *mut Fixture).cast(),
                call: Some(call),
                release: Some(release),
            };
            let input = CString::new(command.to_string()).unwrap();
            unsafe {
                let raw = mfw_send_plan_execute_v1(self.context, &host, input.as_ptr());
                let value = serde_json::from_slice(CStr::from_ptr(raw).to_bytes()).unwrap();
                mfw_send_plan_string_free_v1(raw);
                value
            }
        }
        fn prepare(&mut self) -> Value {
            let result=self.execute(json!({"op":"prepare","bindings":[{"source":{"kind":"registered","id":"fixture"},"label":"Unfunded fixture","network":"stagenet","physicalId":"fixture-physical","readWalletId":"fixture","signingWalletId":"fixture","ownerRegistrationId":null}],"address":"fixture-recipient","amountAtomic":"","priority":"low"}));
            assert_eq!(result["ok"], true, "{result}");
            result["value"].clone()
        }
        fn claim(&mut self, id: &Value) -> String {
            let result = self.execute(json!({"op":"claim","planId":id}));
            assert_eq!(result["ok"], true, "{result}");
            result["value"]["claimToken"].as_str().unwrap().into()
        }
    }
    impl Drop for Harness {
        fn drop(&mut self) {
            unsafe {
                mfw_send_plan_context_destroy_v1(self.context);
            }
        }
    }

    #[test]
    fn native_dispatch_uses_all_accounts_one_claim_and_durable_receipts() {
        let mut h = Harness::new();
        let plan = h.prepare();
        assert_eq!(plan["amountAtomic"], "1160");
        assert_eq!(plan["feeAtomic"], "40");
        assert_eq!(plan["txCount"], 2);
        let token = h.claim(&plan["id"]);
        let command = json!({"op":"commit","planId":plan["id"],"claimToken":token});
        let done = h.execute(command.clone());
        assert_eq!(done["value"]["status"], "ok");
        assert_eq!(h.fixture.commits, 2);
        assert!(!h.fixture.wal_missing);
        assert_eq!(h.execute(command)["value"]["status"], "ok");
        assert_eq!(h.fixture.commits, 2);
        assert_eq!(h.fixture.calls.len(), h.fixture.released);
    }
    #[test]
    fn invalid_claim_or_locked_session_cannot_reach_network() {
        let mut h = Harness::new();
        let plan = h.prepare();
        assert_eq!(
            h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":"42"}))["ok"],
            false
        );
        let token = h.claim(&plan["id"]);
        h.fixture.authorized = false;
        assert_eq!(
            h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}))["ok"],
            false
        );
        assert_eq!(h.fixture.commits, 0);
    }
    #[test]
    fn journal_failure_before_network_produces_known_zero_and_no_commit() {
        let mut h = Harness::new();
        let plan = h.prepare();
        let token = h.claim(&plan["id"]);
        h.fixture.fail_save = Some(h.fixture.saves + 1);
        let result = h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}));
        assert_eq!(result["value"]["broadcastAttempted"], false);
        assert_eq!(h.fixture.commits, 0);
        assert_eq!(result["value"]["broadcastedAmountAtomic"], "0");
    }
    #[test]
    fn restart_and_status_never_relay_uncertain_payment_again() {
        let mut h = Harness::new();
        let plan = h.prepare();
        let token = h.claim(&plan["id"]);
        h.fixture.uncertain = true;
        let result = h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}));
        assert_eq!(result["value"]["status"], "uncertain");
        assert_eq!(h.fixture.commits, 1);
        unsafe {
            mfw_send_plan_context_destroy_v1(h.context);
        }
        h.context = mfw_send_plan_context_create_v1();
        assert_eq!(h.execute(json!({"op":"leases","walletId":"different-session-id","physicalId":"fixture-physical"}))["value"],true);
        assert_eq!(
            h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}))["value"]
                ["status"],
            "uncertain"
        );
        assert_eq!(
            h.execute(json!({"op":"status","planId":plan["id"]}))["value"]["status"],
            "uncertain"
        );
        assert_eq!(h.fixture.commits, 1);
    }
    #[test]
    fn lock_invalidation_and_source_change_invalidate_native_claims() {
        let mut h = Harness::new();
        let plan = h.prepare();
        let token = h.claim(&plan["id"]);
        h.fixture.bad_binding = true;
        assert_eq!(
            h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}))["ok"],
            false
        );
        h.fixture.bad_binding = false;
        h.fixture.authorized = false;
        assert_eq!(h.execute(json!({"op":"invalidate"}))["ok"], true);
        assert!(
            h.fixture.pending.is_empty(),
            "Lock must dispose owned unattempted pointers"
        );
        h.fixture.authorized = true;
        let restored = h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}));
        assert_eq!(restored["value"]["phase"], "discarded");
        assert_eq!(h.fixture.commits, 0);
    }
    #[test]
    fn renderer_clock_or_unknown_command_fields_are_rejected() {
        let mut h = Harness::new();
        assert_eq!(
            h.execute(json!({"op":"status","planId":"fake","now":0}))["ok"],
            false
        );
        assert!(h.fixture.calls.is_empty());
    }

    #[test]
    fn native_receipt_inventory_recovers_without_renderer_cache_or_private_tokens() {
        let mut h = Harness::new();
        let plan = h.prepare();
        let token = h.claim(&plan["id"]);
        h.fixture.uncertain = true;
        h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}));
        unsafe {
            mfw_send_plan_context_destroy_v1(h.context);
        }
        h.context = mfw_send_plan_context_create_v1();
        let list = h.execute(json!({"op":"list"}));
        let saved = &list["value"][0];
        assert_eq!(saved["id"], plan["id"]);
        assert_eq!(saved["leaseHeld"], true);
        assert_eq!(saved["phase"], "interrupted");
        assert!(saved.get("claim").is_none());
        assert!(saved.get("claimToken").is_none());
        assert!(saved.get("bindings").is_none());
        assert_eq!(h.fixture.commits, 1);
    }

    #[test]
    fn native_physical_identity_is_stable_across_names_and_separated_by_network() {
        let address = CString::new("4".repeat(95)).unwrap();
        let mut identities = Vec::new();
        for network in ["mainnet", "stagenet"] {
            let name = CString::new(network).unwrap();
            unsafe {
                let raw = mfw_send_plan_physical_id_v1(name.as_ptr(), address.as_ptr());
                let value: Value = serde_json::from_slice(CStr::from_ptr(raw).to_bytes()).unwrap();
                mfw_send_plan_string_free_v1(raw);
                assert_eq!(value["ok"], true);
                identities.push(value["value"].as_str().unwrap().to_owned());
            }
        }
        assert_ne!(identities[0], identities[1]);
        assert_eq!(
            identities[0].rsplit(':').next(),
            identities[1].rsplit(':').next()
        );
        assert!(identities[0].starts_with("wallet:mainnet:"));
        assert_eq!(identities[0].len(), "wallet:mainnet:".len() + 64);
        assert_eq!(
            identities[0],
            "wallet:mainnet:413d72d790e50eb90b5bce140e0b65829beef1549e6d4c8580ff6bee40d87b28"
        );
    }

    fn adopt_request(h: &mut Harness) -> Value {
        let prepared = h
            .fixture
            .apply(
                "prepare",
                json!({"walletId":"fixture","accountIndex":0,"amountAtomic":"100"}),
            )
            .unwrap();
        json!({"op":"adopt","binding":{"source":{"kind":"registered","id":"fixture"},"label":"Fixture legacy review","network":"stagenet","physicalId":"fixture-physical","readWalletId":"fixture","signingWalletId":"fixture","ownerRegistrationId":null},"accountIndex":0,"prepared":prepared,"address":"fixture-recipient"})
    }

    #[test]
    fn native_legacy_adoption_reuses_its_pending_and_retains_uncertain_journal_hold() {
        let mut h = Harness::new();
        let command = adopt_request(&mut h);
        let plan = h.execute(command);
        assert_eq!(plan["ok"], true);
        assert_eq!(
            h.fixture.serial, 1,
            "Adoption must not prepare a second transaction"
        );
        assert_eq!(h.fixture.commits, 0);
        let id = &plan["value"]["id"];
        let token = h.claim(id);
        h.fixture.uncertain = true;
        let result = h.execute(json!({"op":"commit","planId":id,"claimToken":token}));
        assert_eq!(result["value"]["status"], "uncertain");
        assert_eq!(
            h.execute(json!({"op":"leases","walletId":"fixture","physicalId":"fixture-physical"}))
                ["value"],
            true
        );
        assert_eq!(h.fixture.commits, 1);
        assert!(!h.fixture.wal_missing);
    }

    #[test]
    fn failed_legacy_adoption_cleans_owned_handles_without_relay() {
        let mut h = Harness::new();
        let command = adopt_request(&mut h);
        h.fixture.fail_save = Some(1);
        assert_eq!(h.execute(command)["ok"], false);
        assert!(h.fixture.pending.is_empty());
        assert_eq!(h.fixture.commits, 0);
    }

    #[test]
    fn lock_recovers_proven_unattempted_interrupted_cleanup_without_a_ghost_lease() {
        let mut h = Harness::new();
        let plan = h.prepare();
        let token = h.claim(&plan["id"]);
        h.fixture.fail_all_saves = true;
        let result = h.execute(json!({"op":"commit","planId":plan["id"],"claimToken":token}));
        assert_eq!(result["value"]["phase"], "interrupted");
        assert_eq!(result["value"]["broadcastAttempted"], false);
        h.fixture.authorized = false;
        assert_eq!(h.execute(json!({"op":"invalidate"}))["ok"], true);
        assert!(h.fixture.pending.is_empty());
        h.fixture.authorized = true;
        assert_eq!(
            h.execute(json!({"op":"leases","walletId":"fixture","physicalId":"fixture-physical"}))
                ["value"],
            false
        );
        assert_eq!(h.fixture.commits, 0);
    }
}
