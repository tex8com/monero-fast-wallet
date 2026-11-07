use super::*;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

fn hash(value: u64) -> String {
    format!("{value:064x}")
}

fn binding(name: &str) -> Binding {
    Binding {
        source: Source {
            kind: "registered".into(),
            id: name.into(),
        },
        label: format!("Fixture {name}"),
        network: "stagenet".into(),
        physical_id: format!("physical-{name}"),
        read_wallet_id: format!("read-{name}"),
        signing_wallet_id: format!("sign-{name}"),
        owner_registration_id: Some(name.into()),
    }
}

fn account(index: u32, amount: u64) -> Account {
    Account {
        account_index: index,
        balance_atomic: amount.to_string(),
        unlocked_balance_atomic: amount.to_string(),
    }
}

#[derive(Clone, Copy)]
enum BadPrepared {
    Amount,
    Fee,
    Hash,
    Count,
}

struct FakeNative {
    accounts: HashMap<String, Vec<Account>>,
    normal_fee: u64,
    sweep_fee: u64,
    serial: u64,
    prepare_calls: Vec<(String, u32, String)>,
    discard_calls: Vec<String>,
    commit_calls: Vec<String>,
    active: HashMap<String, Prepared>,
    fail_prepare_call: Option<usize>,
    fail_discard: HashSet<String>,
    bad_prepared: Option<BadPrepared>,
    split_first: bool,
    reports: VecDeque<Result<CommitReport, String>>,
    events: Rc<RefCell<Vec<String>>>,
}

impl Default for FakeNative {
    fn default() -> Self {
        Self {
            accounts: HashMap::new(),
            normal_fee: 30,
            sweep_fee: 10,
            serial: 1,
            prepare_calls: vec![],
            discard_calls: vec![],
            commit_calls: vec![],
            active: HashMap::new(),
            fail_prepare_call: None,
            fail_discard: HashSet::new(),
            bad_prepared: None,
            split_first: false,
            reports: VecDeque::new(),
            events: Rc::new(RefCell::new(vec![])),
        }
    }
}

impl FakeNative {
    fn with_accounts(accounts: &[(u32, u64)]) -> Self {
        let mut native = Self::default();
        native.accounts.insert(
            "sign-a".into(),
            accounts.iter().map(|&(i, v)| account(i, v)).collect(),
        );
        native
    }

    fn insufficient() -> Prepared {
        Prepared {
            id: String::new(),
            status: "error".into(),
            error: "fixture insufficient funds".into(),
            error_code: "insufficient_funds".into(),
            amount_atomic: "0".into(),
            fee_atomic: "0".into(),
            tx_count: 0,
            tx_ids: vec![],
        }
    }
}

impl Native for FakeNative {
    fn accounts(&mut self, wallet: &str) -> Result<Vec<Account>, String> {
        self.accounts
            .get(wallet)
            .cloned()
            .ok_or_else(|| "unknown fixture wallet".into())
    }

    fn prepare(
        &mut self,
        wallet: &str,
        _address: &str,
        amount: &str,
        _priority: &str,
        index: u32,
    ) -> Result<Prepared, String> {
        self.prepare_calls
            .push((wallet.into(), index, amount.into()));
        if self.fail_prepare_call == Some(self.prepare_calls.len()) {
            return Err("fixture transport failed before preparation".into());
        }
        let available = self
            .accounts
            .get(wallet)
            .and_then(|a| a.iter().find(|a| a.account_index == index))
            .ok_or_else(|| "missing fixture account".to_owned())?;
        let budget = atomic(&available.unlocked_balance_atomic)?;
        let fee = if amount.is_empty() {
            self.sweep_fee
        } else {
            self.normal_fee
        };
        let recipient = if amount.is_empty() {
            match budget.checked_sub(fee).filter(|v| *v > 0) {
                Some(v) => v,
                None => return Ok(Self::insufficient()),
            }
        } else {
            let requested = atomic(amount)?;
            if requested.checked_add(fee).is_none_or(|v| v > budget) {
                return Ok(Self::insufficient());
            }
            requested
        };
        let serial = self.serial;
        self.serial += 4;
        let split = self.split_first && self.active.is_empty();
        let mut result = Prepared {
            id: format!("pending-{serial}"),
            status: "ok".into(),
            error: String::new(),
            error_code: String::new(),
            amount_atomic: recipient.to_string(),
            fee_atomic: fee.to_string(),
            tx_count: if split { 3 } else { 1 },
            tx_ids: (0..if split { 3 } else { 1 })
                .map(|n| hash(serial + n))
                .collect(),
        };
        if let Some(bad) = self.bad_prepared.take() {
            match bad {
                BadPrepared::Amount => result.amount_atomic = "not-an-atomic-amount".into(),
                BadPrepared::Fee => result.fee_atomic = "18446744073709551616".into(),
                BadPrepared::Hash => result.tx_ids[0] = "not-a-hash".into(),
                BadPrepared::Count => result.tx_count += 1,
            }
        }
        self.active.insert(result.id.clone(), result.clone());
        Ok(result)
    }

    fn discard(&mut self, _wallet: &str, pending: &str) -> Result<(), String> {
        self.discard_calls.push(pending.into());
        if self.fail_discard.contains(pending) {
            return Err("fixture cleanup failed".into());
        }
        self.active.remove(pending);
        Ok(())
    }

    fn commit(&mut self, _wallet: &str, pending: &str) -> Result<CommitReport, String> {
        self.commit_calls.push(pending.into());
        self.events.borrow_mut().push(format!("commit:{pending}"));
        let prepared = self
            .active
            .get(pending)
            .cloned()
            .ok_or_else(|| "fixture pending missing".to_owned())?;
        if let Some(report) = self.reports.pop_front() {
            return report;
        }
        self.active.remove(pending);
        Ok(CommitReport {
            status: "ok".into(),
            error: String::new(),
            broadcasted_tx_ids: prepared.tx_ids,
            uncertain_tx_ids: vec![],
            remaining_tx_ids: vec![],
            broadcasted_transactions: vec![],
            broadcasted_amount_atomic: Some(prepared.amount_atomic),
            broadcasted_fee_atomic: Some(prepared.fee_atomic),
            broadcasted_totals_known: true,
        })
    }
}

#[derive(Default)]
struct MemoryJournal {
    durable: Vec<Plan>,
    writes: Vec<Plan>,
    save_calls: usize,
    fail_save_call: Option<usize>,
    fail_load: bool,
    events: Rc<RefCell<Vec<String>>>,
}

impl Journal for MemoryJournal {
    fn load(&mut self) -> Result<Vec<Plan>, String> {
        if self.fail_load {
            return Err("fixture journal read failure".into());
        }
        Ok(self.durable.clone())
    }
    fn save(&mut self, plan: &Plan) -> Result<(), String> {
        self.save_calls += 1;
        self.events
            .borrow_mut()
            .push(format!("save:{}", plan.phase));
        if self.fail_save_call == Some(self.save_calls) {
            return Err("fixture journal write failure".into());
        }
        self.writes.push(plan.clone());
        self.durable.retain(|p| p.id != plan.id);
        self.durable.push(plan.clone());
        Ok(())
    }
}

fn reserve(store: &mut Store, journal: &mut MemoryJournal, bindings: Vec<Binding>) -> Plan {
    store
        .reserve("fixture-plan".into(), bindings, journal)
        .unwrap();
    store.get("fixture-plan").unwrap()
}

fn prepared(native: &mut FakeNative, amount: &str) -> (Store, Plan, MemoryJournal) {
    prepared_sources(native, amount, vec![binding("a")])
}

fn prepared_sources(
    native: &mut FakeNative,
    amount: &str,
    bindings: Vec<Binding>,
) -> (Store, Plan, MemoryJournal) {
    let mut store = Store::default();
    let mut journal = MemoryJournal {
        events: native.events.clone(),
        ..Default::default()
    };
    let plan = reserve(&mut store, &mut journal, bindings);
    let plan = prepare(native, plan, "fixture-recipient".into(), amount, "low").unwrap();
    let plan = store.publish(plan, 1000).unwrap();
    (store, plan, journal)
}

fn start(store: &mut Store) -> Plan {
    let (plan, claim) = store.claim("fixture-plan", 1001).unwrap();
    assert_eq!(plan.phase, "authorizing");
    store.start("fixture-plan", claim, 1002).unwrap()
}

#[test]
fn max_uses_all_funded_accounts_with_exact_native_fees() {
    let mut native = FakeNative::with_accounts(&[(0, 500), (1, 1000), (2, 0)]);
    let (_store, plan, _journal) = prepared(&mut native, "");
    assert_eq!(
        plan.members
            .iter()
            .map(|m| m.account_index)
            .collect::<Vec<_>>(),
        [1, 0]
    );
    assert!(native
        .prepare_calls
        .iter()
        .all(|(_, _, amount)| amount.is_empty()));
    let (amount, fee, total, ids) = plan.financials().unwrap();
    assert_eq!((amount, fee, total, ids.len()), (1480, 20, 1500, 2));
    assert!(native.commit_calls.is_empty());
}

#[test]
fn explicitly_selected_independent_wallets_fund_one_exact_review() {
    let mut native = FakeNative::with_accounts(&[(0, 1000)]);
    native
        .accounts
        .insert("sign-b".into(), vec![account(0, 500)]);
    let (_store, plan, _journal) =
        prepared_sources(&mut native, "", vec![binding("a"), binding("b")]);
    assert_eq!(plan.financials().unwrap().0, 1480);
    assert_eq!(plan.financials().unwrap().1, 20);
    assert_eq!(plan.bindings.len(), 2);
    assert_eq!(
        plan.members
            .iter()
            .map(|m| m.binding_index)
            .collect::<Vec<_>>(),
        [0, 1]
    );
    assert_eq!(
        native
            .prepare_calls
            .iter()
            .map(|(w, _, _)| w.as_str())
            .collect::<Vec<_>>(),
        ["sign-a", "sign-b"]
    );
    assert!(native.commit_calls.is_empty());
}

#[test]
fn max_never_uses_locked_account_balance() {
    let mut native = FakeNative::with_accounts(&[(0, 500)]);
    native.accounts.get_mut("sign-a").unwrap()[0].balance_atomic = "1000".into();
    let (_, plan, _) = prepared(&mut native, "");
    assert_eq!(plan.financials().unwrap().0, 490);
    assert_eq!(plan.financials().unwrap().2, 500);
}

#[test]
fn fixed_amount_spans_accounts_and_never_overpays() {
    let mut native = FakeNative::with_accounts(&[(0, 500), (1, 1000)]);
    let (_store, plan, _journal) = prepared(&mut native, "1200");
    assert_eq!(plan.members.len(), 2);
    assert_eq!(plan.financials().unwrap().0, 1200);
    assert_eq!(
        native
            .prepare_calls
            .iter()
            .map(|(_, a, v)| (*a, v.as_str()))
            .collect::<Vec<_>>(),
        [(1, ""), (0, "210")]
    );
    assert!(native.commit_calls.is_empty());
}

#[test]
fn fee_edge_discards_the_probe_and_allocates_exact_remainder() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    let (_store, plan, _journal) = prepared(&mut native, "980");
    assert_eq!(plan.financials().unwrap().0, 980);
    assert_eq!(plan.members.len(), 2);
    assert_eq!(
        native.discard_calls.len(),
        1,
        "larger sweep probe must be disposed"
    );
    assert_eq!(
        native.active.len(),
        2,
        "only final recipient-bound transactions remain"
    );
    assert_eq!(
        native
            .prepare_calls
            .iter()
            .map(|(_, a, v)| (*a, v.as_str()))
            .collect::<Vec<_>>(),
        [(0, "980"), (0, ""), (0, "970"), (1, "10")]
    );
}

#[test]
fn failed_preparation_returns_cleanup_ownership_and_never_partially_sends() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    native.fail_prepare_call = Some(2);
    let mut store = Store::default();
    let mut journal = MemoryJournal::default();
    let plan = reserve(&mut store, &mut journal, vec![binding("a")]);
    let (_, mut failed) =
        prepare(&mut native, plan, "fixture-recipient".into(), "", "low").unwrap_err();
    assert_eq!(failed.members.len(), 1);
    assert_eq!(native.active.len(), 1);
    let pending = failed.members[0].prepared.id.clone();
    native.fail_discard.insert(pending);
    assert!(discard(&mut native, &mut failed).is_err());
    assert!(
        failed.lease_held,
        "cleanup failure must retain the source lease"
    );
    store.replace(failed.clone());
    assert!(store
        .reserve("another".into(), vec![binding("a")], &mut journal)
        .is_err());
    native.fail_discard.clear();
    discard(&mut native, &mut failed).unwrap();
    assert!(native.active.is_empty() && native.commit_calls.is_empty());
    assert_eq!(failed.phase, "discarded");
    assert!(!failed.lease_held);
}

#[test]
fn malformed_native_metadata_keeps_the_pending_handle_available_for_cleanup() {
    for bad in [
        BadPrepared::Amount,
        BadPrepared::Fee,
        BadPrepared::Hash,
        BadPrepared::Count,
    ] {
        let mut native = FakeNative::with_accounts(&[(0, 1000)]);
        native.bad_prepared = Some(bad);
        let mut store = Store::default();
        let mut journal = MemoryJournal::default();
        let plan = reserve(&mut store, &mut journal, vec![binding("a")]);
        let (_, mut failed) =
            prepare(&mut native, plan, "fixture-recipient".into(), "", "low").unwrap_err();
        assert_eq!(native.active.len(), 1);
        discard(&mut native, &mut failed).unwrap();
        assert!(
            native.active.is_empty(),
            "invalid metadata must not orphan a native pending handle"
        );
        assert!(native.commit_calls.is_empty());
    }
}

#[test]
fn overflow_and_inconsistent_account_balances_fail_closed() {
    let mut native = FakeNative::with_accounts(&[(0, u64::MAX), (1, u64::MAX)]);
    let mut store = Store::default();
    let mut journal = MemoryJournal::default();
    let plan = reserve(&mut store, &mut journal, vec![binding("a")]);
    let (_, mut failed) =
        prepare(&mut native, plan, "fixture-recipient".into(), "", "low").unwrap_err();
    let public = failed.public();
    assert_eq!(public["status"], "error");
    assert!(public["amountAtomic"].is_null() && public["totalAtomic"].is_null());
    discard(&mut native, &mut failed).unwrap();
    assert!(native.active.is_empty() && native.commit_calls.is_empty());

    let mut native = FakeNative::with_accounts(&[(0, 1000)]);
    native.accounts.get_mut("sign-a").unwrap()[0].balance_atomic = "999".into();
    let mut store = Store::default();
    let plan = reserve(&mut store, &mut journal, vec![binding("a")]);
    assert!(prepare(&mut native, plan, "fixture-recipient".into(), "", "low").is_err());
    assert!(native.prepare_calls.is_empty());
    assert!(atomic("18446744073709551616").is_err());
    assert!(atomic("1e6").is_err());
}

#[test]
fn physical_aliases_network_mismatch_and_existing_leases_are_rejected() {
    let mut store = Store::default();
    let mut journal = MemoryJournal::default();
    let mut alias = binding("alias");
    alias.physical_id = binding("a").physical_id;
    assert!(store
        .reserve("aliases".into(), vec![binding("a"), alias], &mut journal)
        .is_err());
    let mut other_network = binding("b");
    other_network.network = "mainnet".into();
    assert!(store
        .reserve(
            "networks".into(),
            vec![binding("a"), other_network],
            &mut journal
        )
        .is_err());
    let plan = reserve(&mut store, &mut journal, vec![binding("a")]);
    assert!(store.leases_wallet(&plan.bindings[0].read_wallet_id));
    assert!(store.leases_wallet(&plan.bindings[0].signing_wallet_id));
    assert!(store
        .reserve("double".into(), vec![binding("a")], &mut journal)
        .is_err());
    journal.fail_load = true;
    let mut empty = Store::default();
    assert!(empty
        .reserve("read-failed".into(), vec![binding("b")], &mut journal)
        .is_err());
    assert!(empty.get("read-failed").is_none());
}

#[test]
fn approval_ttl_starts_after_preparation_and_claims_do_not_survive_lock() {
    let mut native = FakeNative::with_accounts(&[(0, 1000)]);
    let (mut store, plan, mut journal) = prepared(&mut native, "");
    assert_eq!(plan.expires_at, 1120);
    let (_, old_claim) = store.claim(&plan.id, 1001).unwrap();
    assert!(store.claim(&plan.id, 1001).is_err());
    assert!(store.validate_claim(&plan.id, old_claim, 1119).is_ok());
    assert!(store.validate_claim(&plan.id, old_claim, 1120).is_err());
    store.clear();
    assert!(store.validate_claim(&plan.id, old_claim, 1002).is_err());
    let reservation = reserve(&mut store, &mut journal, vec![binding("a")]);
    assert!(
        store.claim(&reservation.id, 5000).is_err(),
        "preparing has no approval"
    );
    let staged = prepare(
        &mut native,
        reservation,
        "fixture-recipient".into(),
        "",
        "low",
    )
    .unwrap();
    let fresh = store.publish(staged, 5000).unwrap();
    assert_eq!(fresh.expires_at, 5120);
    let (_, new_claim) = store.claim(&fresh.id, 5001).unwrap();
    assert_ne!(old_claim, new_claim);
    assert!(store.validate_claim(&fresh.id, old_claim, 5001).is_err());
    store.release_claim(&fresh.id, old_claim);
    assert!(
        store.claim(&fresh.id, 5001).is_err(),
        "stale cancellation cannot release a new claim"
    );
    store.release_claim(&fresh.id, new_claim);
    assert!(store.claim(&fresh.id, 5001).is_ok());
}

#[test]
fn journal_write_failure_before_network_means_zero_commit_calls() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    journal.fail_save_call = Some(1);
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    assert!(native.commit_calls.is_empty());
    assert!(!plan.broadcast_attempted);
    assert_eq!(plan.public()["broadcastAttempted"], false);
    assert!(plan
        .error
        .as_deref()
        .unwrap()
        .contains("no further transaction"));
    assert!(native.active.is_empty());
    assert!(plan.broadcasted_tx_ids.is_empty() && plan.uncertain_tx_ids.is_empty());
}

#[test]
fn native_partial_report_accepts_real_prefix_shape_and_stops_before_next_member() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    native.split_first = true;
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    let ids = plan.members[0].prepared.tx_ids.clone();
    native.reports.push_back(Ok(CommitReport {
        status: "partial".into(),
        error: "fixture daemon timeout after first relay".into(),
        broadcasted_tx_ids: vec![ids[2].clone()],
        uncertain_tx_ids: vec![ids[1].clone()],
        remaining_tx_ids: ids[..2].to_vec(),
        broadcasted_transactions: vec![],
        broadcasted_amount_atomic: Some("490".into()),
        broadcasted_fee_atomic: Some("4".into()),
        broadcasted_totals_known: true,
    }));
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    assert_eq!(native.commit_calls.len(), 1);
    assert_eq!(plan.broadcasted_tx_ids, [ids[2].clone()]);
    assert_eq!(plan.uncertain_tx_ids, [ids[1].clone()]);
    assert!(plan.lease_held);
    let public = plan.public();
    assert_eq!(public["status"], "uncertain");
    assert_eq!(public["broadcastedAmountAtomic"], "490");
    assert_eq!(public["broadcastedFeeAtomic"], "4");
    assert_eq!(public["broadcastedTotalsKnown"], true);
    assert!(public["remainingTxIds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == &ids[0]));
    assert!(!public["remainingTxIds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == &ids[1]));
}

#[test]
fn timeout_stops_following_sources_and_restart_receipts_cannot_execute() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    let first_ids = plan.members[0].prepared.tx_ids.clone();
    native
        .reports
        .push_back(Err("fixture lost native response".into()));
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    assert_eq!(native.commit_calls.len(), 1);
    assert_eq!(plan.uncertain_tx_ids, first_ids);
    assert!(plan.broadcasted_tx_ids.is_empty() && plan.lease_held);
    store.replace(plan.clone());
    let receipt = store.get(&plan.id).unwrap().public();
    assert!(store.claim(&plan.id, 1003).is_err());
    assert_eq!(store.get(&plan.id).unwrap().public(), receipt);
    assert_eq!(native.commit_calls.len(), 1, "status replay cannot relay");
    let restored = recovered(journal.durable.last().unwrap().clone());
    assert_eq!(restored.phase, "interrupted");
    assert!(restored.lease_held);
    let mut restarted_store = Store::default();
    assert!(restarted_store.claim(&restored.id, 1004).is_err());
    journal.durable = vec![restored];
    assert!(restarted_store
        .reserve("fresh-payment".into(), vec![binding("a")], &mut journal)
        .is_err());
}

#[test]
fn crash_before_network_discards_ready_authorizations_and_releases_the_source() {
    for phase in ["prepared", "authorizing"] {
        let mut native = FakeNative::with_accounts(&[(0, 1000)]);
        let (_store, mut plan, _) = prepared(&mut native, "");
        plan.phase = phase.into();
        plan.claim = 7;
        assert!(!plan.broadcast_attempted);
        let restored = recovered(plan.clone());
        assert_eq!(restored.phase, "discarded");
        assert!(!restored.lease_held);
        assert!(!restored.broadcast_attempted);
        assert!(restored.broadcasted_tx_ids.is_empty() && restored.uncertain_tx_ids.is_empty());
        let mut journal = MemoryJournal {
            durable: vec![plan],
            ..Default::default()
        };
        let mut restarted = Store::default();
        restarted
            .reserve(
                "new-session-payment".into(),
                vec![binding("a")],
                &mut journal,
            )
            .unwrap();
        assert!(restarted.claim(&restored.id, 1005).is_err());
        assert!(native.commit_calls.is_empty());
    }
}

#[test]
fn empty_preparation_cleanup_cannot_turn_known_zero_relay_into_unknown_amounts() {
    for phase in ["preparing", "cleanup_failed"] {
        let mut native = FakeNative::default();
        let mut store = Store::default();
        let mut journal = MemoryJournal::default();
        let mut plan = reserve(&mut store, &mut journal, vec![binding("a")]);
        plan.phase = phase.into();
        discard(&mut native, &mut plan).unwrap();
        let public = plan.public();
        assert_eq!(public["phase"], "discarded");
        assert_eq!(public["broadcastAttempted"], false);
        assert_eq!(public["broadcastedAmountAtomic"], "0");
        assert_eq!(public["broadcastedFeeAtomic"], "0");
        assert_eq!(public["broadcastedTotalsKnown"], true);
        assert!(public["amountAtomic"].is_null());
        assert!(!plan.lease_held);
        assert!(native.commit_calls.is_empty());
        let recovered_plan = recovered(plan);
        assert_eq!(recovered_plan.phase, "discarded");
        assert!(!recovered_plan.lease_held && !recovered_plan.broadcast_attempted);
    }
}

#[test]
fn durable_uncertain_marker_is_written_before_every_network_attempt() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    let events = native.events.borrow();
    for (index, event) in events.iter().enumerate() {
        if event.starts_with("commit:") {
            assert!(index > 0 && events[index - 1].starts_with("save:"));
        }
    }
    assert_eq!(native.commit_calls.len(), 2);
    assert!(plan.broadcast_attempted);
    assert!(journal.writes.iter().all(|write| write.broadcast_attempted));
    assert_eq!(plan.public()["broadcastAttempted"], true);
    assert_eq!(plan.public()["broadcastedAmountAtomic"], "1480");
    assert_eq!(plan.public()["status"], "ok");
    assert!(!plan.lease_held);
}

#[test]
fn post_relay_journal_failure_keeps_a_non_replayable_recovery_marker() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    journal.fail_save_call = Some(2);
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    assert_eq!(native.commit_calls.len(), 1);
    assert!(plan.lease_held && plan.error.is_some());
    assert!(plan.broadcast_attempted);
    let persisted = journal.durable.last().unwrap();
    assert_eq!(persisted.phase, "broadcasting");
    assert!(persisted.broadcast_attempted);
    assert_eq!(persisted.uncertain_tx_ids, plan.members[0].prepared.tx_ids);
    assert_eq!(recovered(persisted.clone()).phase, "interrupted");
}

#[test]
fn missing_partial_receipt_values_stay_unknown_instead_of_invented_zeroes() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    native.split_first = true;
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    let ids = plan.members[0].prepared.tx_ids.clone();
    native.reports.push_back(Ok(CommitReport {
        status: "partial".into(),
        error: "fixture partial relay without local detail".into(),
        broadcasted_tx_ids: vec![ids[2].clone()],
        uncertain_tx_ids: vec![ids[1].clone()],
        remaining_tx_ids: ids[..2].to_vec(),
        broadcasted_transactions: vec![],
        broadcasted_amount_atomic: None,
        broadcasted_fee_atomic: None,
        broadcasted_totals_known: false,
    }));
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    let public = plan.public();
    assert_eq!(native.commit_calls.len(), 1);
    assert_eq!(public["broadcastedTxIds"][0], ids[2]);
    assert!(public["broadcastedAmountAtomic"].is_null());
    assert!(public["broadcastedFeeAtomic"].is_null());
    assert_eq!(public["broadcastedTotalsKnown"], false);
    assert_eq!(public["status"], "uncertain");
}

#[test]
fn impossible_native_aggregate_stops_before_another_member_is_relayed() {
    let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    native.reports.push_back(Ok(CommitReport {
        status: "ok".into(),
        error: String::new(),
        broadcasted_tx_ids: plan.members[0].prepared.tx_ids.clone(),
        uncertain_tx_ids: vec![],
        remaining_tx_ids: vec![],
        broadcasted_transactions: vec![],
        broadcasted_amount_atomic: Some("999999".into()),
        broadcasted_fee_atomic: Some("1".into()),
        broadcasted_totals_known: true,
    }));
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    assert_eq!(
        native.commit_calls.len(),
        1,
        "untrusted receipt totals must stop the plan before further relay"
    );
    assert!(plan.error.is_some());
    assert!(plan.public()["broadcastedAmountAtomic"].is_null());
    assert_eq!(plan.public()["status"], "uncertain");
}

#[test]
fn fully_known_ids_require_exact_approved_totals_instead_of_a_false_zero_receipt() {
    for (amount, fee) in [("0", "0"), ("1", "10"), ("990", "0")] {
        let mut native = FakeNative::with_accounts(&[(0, 1000), (1, 500)]);
        let (mut store, _, mut journal) = prepared(&mut native, "");
        let mut plan = start(&mut store);
        native.reports.push_back(Ok(CommitReport {
            status: "ok".into(),
            error: String::new(),
            broadcasted_tx_ids: plan.members[0].prepared.tx_ids.clone(),
            uncertain_tx_ids: vec![],
            remaining_tx_ids: vec![],
            broadcasted_transactions: vec![],
            broadcasted_amount_atomic: Some(amount.into()),
            broadcasted_fee_atomic: Some(fee.into()),
            broadcasted_totals_known: true,
        }));
        commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
        assert_eq!(native.commit_calls.len(), 1);
        assert!(plan.error.is_some());
        assert_eq!(plan.broadcasted_tx_ids, plan.members[0].prepared.tx_ids);
        assert!(plan.public()["broadcastedAmountAtomic"].is_null());
        assert!(plan.public()["broadcastedFeeAtomic"].is_null());
        assert_eq!(plan.public()["status"], "uncertain");
    }
}

fn confirmed_history(
    hash: &str,
    account_index: u32,
    amount: &str,
    fee: &str,
) -> HistoryTransaction {
    HistoryTransaction {
        hash: hash.into(),
        direction: "out".into(),
        failed: false,
        pending: false,
        block_height: "42".into(),
        amount_atomic: Some(amount.into()),
        fee_atomic: Some(fee.into()),
        subaddress_account: Some(account_index),
        subaddress_indices: vec![0],
    }
}

fn uncertain_fixture(split: bool) -> (FakeNative, Plan) {
    let mut native = FakeNative::with_accounts(&[(0, 1000)]);
    native.split_first = split;
    let (mut store, _, mut journal) = prepared(&mut native, "");
    let mut plan = start(&mut store);
    native
        .reports
        .push_back(Err("fixture relay acknowledgement lost".into()));
    commit(&mut native, &mut journal, &mut plan, |_| Ok(()));
    (native, plan)
}

#[test]
fn confirmed_history_promotes_known_hashes_and_restores_exact_approved_totals() {
    let (native, mut plan) = uncertain_fixture(false);
    let tx_id = plan.members[0].prepared.tx_ids[0].clone();
    let mut incoming = confirmed_history(&tx_id, 0, "990", "10");
    incoming.direction = "in".into();
    let evidence = HistoryEvidence {
        physical_id: plan.bindings[0].physical_id.clone(),
        network: plan.network.clone(),
        // Self payments may expose an incoming row before the outgoing row.
        transactions: vec![incoming, confirmed_history(&tx_id, 0, "990", "10")],
    };
    let lease_before = plan.lease_held;
    let commits_before = native.commit_calls.len();
    let discards_before = native.discard_calls.len();
    assert!(reconcile_positive(&mut plan, &[evidence]).unwrap());
    assert_eq!(plan.broadcasted_tx_ids, [tx_id]);
    assert!(plan.uncertain_tx_ids.is_empty());
    assert_eq!(plan.public()["broadcastedAmountAtomic"], "990");
    assert_eq!(plan.public()["broadcastedFeeAtomic"], "10");
    assert_eq!(plan.public()["broadcastedTotalsKnown"], true);
    assert_eq!(
        plan.lease_held, lease_before,
        "pure reconciliation cannot release a source lease"
    );
    assert_eq!(native.commit_calls.len(), commits_before);
    assert_eq!(native.discard_calls.len(), discards_before);
}

#[test]
fn missing_pending_failed_incoming_and_wrongly_bound_history_never_resolve_uncertainty() {
    for variant in 0..9 {
        let (native, mut plan) = uncertain_fixture(false);
        let tx_id = plan.members[0].prepared.tx_ids[0].clone();
        let mut evidence = HistoryEvidence {
            physical_id: plan.bindings[0].physical_id.clone(),
            network: plan.network.clone(),
            transactions: vec![confirmed_history(&tx_id, 0, "990", "10")],
        };
        match variant {
            0 => evidence.transactions.clear(),
            1 => evidence.transactions[0].pending = true,
            2 => evidence.transactions[0].failed = true,
            3 => evidence.physical_id = "different-physical-wallet".into(),
            4 => evidence.network = "mainnet".into(),
            5 => evidence.transactions[0].direction = "in".into(),
            6 => evidence.transactions[0].subaddress_account = Some(1),
            7 => evidence.transactions[0].block_height = "0".into(),
            8 => evidence.transactions[0].hash = hash(999999),
            _ => unreachable!(),
        }
        let lease_before = plan.lease_held;
        let commits_before = native.commit_calls.len();
        assert!(!reconcile_positive(&mut plan, &[evidence]).unwrap());
        assert_eq!(plan.uncertain_tx_ids, [tx_id]);
        assert!(plan.broadcasted_tx_ids.is_empty());
        assert_eq!(plan.lease_held, lease_before);
        assert_eq!(native.commit_calls.len(), commits_before);
    }
}

#[test]
fn partial_positive_history_never_infers_absent_transactions_were_not_sent() {
    let (native, mut plan) = uncertain_fixture(true);
    let ids = plan.members[0].prepared.tx_ids.clone();
    let evidence = HistoryEvidence {
        physical_id: plan.bindings[0].physical_id.clone(),
        network: plan.network.clone(),
        transactions: vec![confirmed_history(&ids[2], 0, "490", "4")],
    };
    assert!(reconcile_positive(&mut plan, &[evidence]).unwrap());
    assert_eq!(plan.broadcasted_tx_ids, [ids[2].clone()]);
    assert_eq!(plan.uncertain_tx_ids, ids[..2]);
    assert!(plan.lease_held);
    assert_eq!(native.commit_calls.len(), 1);
    assert_eq!(plan.public()["status"], "uncertain");
}

#[test]
fn restarted_receipt_can_resolve_positive_history_without_native_pending_cleanup() {
    let (native, plan) = uncertain_fixture(false);
    let mut restarted: Plan = serde_json::from_str(&serde_json::to_string(&plan).unwrap()).unwrap();
    assert!(
        !restarted.live_pending,
        "native handles must never survive receipt serialization"
    );
    restarted = recovered(restarted);
    let tx_id = restarted.members[0].prepared.tx_ids[0].clone();
    let evidence = HistoryEvidence {
        physical_id: restarted.bindings[0].physical_id.clone(),
        network: restarted.network.clone(),
        transactions: vec![confirmed_history(&tx_id, 0, "990", "10")],
    };
    let discards_before = native.discard_calls.len();
    let commits_before = native.commit_calls.len();
    assert!(reconcile_positive(&mut restarted, &[evidence]).unwrap());
    assert_eq!(restarted.broadcasted_tx_ids, [tx_id]);
    assert!(restarted.uncertain_tx_ids.is_empty());
    assert!(!restarted.live_pending);
    assert!(
        restarted.lease_held,
        "the caller must settle its lease explicitly"
    );
    assert_eq!(native.discard_calls.len(), discards_before);
    assert_eq!(native.commit_calls.len(), commits_before);
}
