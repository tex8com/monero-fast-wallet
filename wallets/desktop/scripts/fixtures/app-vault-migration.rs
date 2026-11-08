//! Execute the unchanged production migration against explicit in-memory I/O.
use std::{cell::RefCell, collections::{HashMap, HashSet}};

struct AppHandle;
trait Zeroize { fn zeroize(&mut self); }
impl Zeroize for String { fn zeroize(&mut self) { self.clear(); } }

#[derive(Clone)]
struct Registration { id: String, source_wallet_id: Option<String>, role: Option<String> }
#[derive(Clone)]
struct FastWallet { id: String }
struct Registry { wallets: Vec<Registration> }

#[derive(Default)]
struct State {
    marker: bool,
    normal_ids: Vec<Registration>,
    fast_ids: Vec<FastWallet>,
    vault: HashMap<String, String>,
    durable: HashMap<String, String>,
    legacy: HashMap<String, String>,
    vault_read_errors: HashSet<String>,
    legacy_read_errors: HashSet<String>,
    legacy_reads: Vec<String>,
    deleted: Vec<String>,
    persist_calls: Vec<bool>,
    fail_persist: bool,
}
thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }
fn state<T>(operation: impl FnOnce(&mut State) -> T) -> T {
    STATE.with(|value| operation(&mut value.borrow_mut()))
}

mod wallet_registry {
    use super::*;
    pub fn list(_: &AppHandle) -> Result<Registry, String> {
        Ok(state(|value| Registry { wallets: value.normal_ids.clone() }))
    }
}
mod fast_wallet {
    use super::*;
    pub fn list(_: &AppHandle) -> Result<Vec<FastWallet>, String> {
        Ok(state(|value| value.fast_ids.clone()))
    }
}
mod diagnostics {
    pub fn record(_: &super::AppHandle, _: &str, _: &[(&str, String)]) {}
}
mod secure_store {
    use super::*;
    pub fn app_vault_migration_committed() -> Result<bool, String> { Ok(state(|value| value.marker)) }
    pub fn wallet_app_vault_key(id: &str) -> Result<String, String> { Ok(format!("normal:{id}")) }
    pub fn fast_wallet_app_vault_key(id: &str) -> Result<String, String> { Ok(format!("fast:{id}")) }
    fn current(key: &str) -> Result<Option<String>, String> {
        state(|value| if value.vault_read_errors.contains(key) { Err("vault read error".into()) }
              else { Ok(value.vault.get(key).cloned()) })
    }
    fn legacy(key: &str) -> Result<Option<String>, String> {
        state(|value| {
            value.legacy_reads.push(key.into());
            if value.legacy_read_errors.contains(key) { Err("legacy read error".into()) }
            else { Ok(value.legacy.get(key).cloned()) }
        })
    }
    pub fn load_wallet_password_current(id: &str) -> Result<Option<String>, String> { current(&wallet_app_vault_key(id)?) }
    pub fn load_fast_wallet_password_current(id: &str) -> Result<Option<String>, String> { current(&fast_wallet_app_vault_key(id)?) }
    pub fn load_legacy_wallet_password_current(id: &str) -> Result<Option<String>, String> { legacy(&wallet_app_vault_key(id)?) }
    pub fn load_legacy_fast_wallet_password_current(id: &str) -> Result<Option<String>, String> { legacy(&fast_wallet_app_vault_key(id)?) }
    fn persist(entries: &[(String, String)], commit: bool) -> Result<(), String> {
        state(|value| {
            // Match AppVault's real failure boundary: memory and the marker can
            // change before persist_payload/write_verified returns an error.
            value.persist_calls.push(commit);
            for (key, secret) in entries { value.vault.insert(key.clone(), secret.clone()); }
            value.marker |= commit;
            if value.fail_persist { return Err("verified durable write failed".into()); }
            value.durable = value.vault.clone();
            Ok(())
        })
    }
    pub fn commit_legacy_wallet_credentials(entries: &[(String, String)]) -> Result<(), String> { persist(entries, true) }
    pub fn merge_legacy_wallet_credentials(entries: &[(String, String)]) -> Result<(), String> { persist(entries, false) }
    fn delete(key: String) -> Result<(), String> {
        state(|value| {
            assert_eq!(value.durable.get(&key), value.vault.get(&key), "cleanup before the exact vault value is durable");
            assert!(value.durable.contains_key(&key), "cleanup without a durable vault value");
            value.legacy.remove(&key);
            value.deleted.push(key);
            Ok(())
        })
    }
    pub fn delete_legacy_wallet_password(id: &str) -> Result<(), String> { delete(wallet_app_vault_key(id)?) }
    pub fn delete_legacy_fast_wallet_password(id: &str) -> Result<(), String> { delete(fast_wallet_app_vault_key(id)?) }
}

include!(env!("MFW_APP_VAULT_MIGRATION_FUNCTION"));

const KEYS: [&str; 2] = ["normal:wallet", "fast:identity"];
fn setup(marker: bool) {
    state(|value| {
        *value = State { marker,
            normal_ids: vec![Registration { id: "wallet".into(), source_wallet_id: None, role: None }],
            fast_ids: vec![FastWallet { id: "identity".into() }], ..State::default() };
        for key in KEYS { value.legacy.insert(key.into(), format!("legacy-{key}")); }
    });
}
fn prime() -> Result<(), String> { migrate_and_prime_app_session_credentials(&AppHandle) }
fn assert_originals_retained() {
    state(|value| {
        assert!(value.deleted.is_empty());
        for key in KEYS { assert!(value.legacy.contains_key(key)); }
    });
}

#[test]
fn committed_marker_missing_vault_and_unreadable_legacy_preserves_normal_and_fast() {
    setup(true);
    state(|value| value.legacy_read_errors.extend(KEYS.map(String::from)));
    prime().unwrap();
    assert_originals_retained();
    state(|value| assert!(value.persist_calls.is_empty()));
}

#[test]
fn committed_marker_vault_read_errors_never_read_or_delete_legacy() {
    setup(true);
    state(|value| value.vault_read_errors.extend(KEYS.map(String::from)));
    prime().unwrap();
    assert_originals_retained();
    state(|value| { assert!(value.legacy_reads.is_empty()); assert!(value.persist_calls.is_empty()); });
}

#[test]
fn committed_marker_still_recovers_missing_normal_and_fast_credentials() {
    setup(true);
    prime().unwrap();
    state(|value| {
        assert_eq!(value.persist_calls, [false]);
        assert_eq!(value.deleted.len(), 2);
        for key in KEYS { assert_eq!(value.durable[key], format!("legacy-{key}")); }
    });
}

#[test]
fn first_transfer_commits_normal_and_fast_before_cleanup() {
    setup(false);
    prime().unwrap();
    state(|value| { assert_eq!(value.persist_calls, [true]); assert!(value.marker); assert!(value.legacy.is_empty()); });
}

#[test]
fn failed_commit_preserves_both_originals_despite_memory_and_marker_changes() {
    setup(false);
    state(|value| value.fail_persist = true);
    assert!(prime().is_err());
    assert_originals_retained();
    state(|value| { assert!(value.marker); assert_eq!(value.vault.len(), 2); assert!(value.durable.is_empty()); });
}

#[test]
fn retry_after_failed_commit_requires_successful_persist_even_with_current_values_and_marker() {
    setup(false);
    state(|value| value.fail_persist = true);
    assert!(prime().is_err());
    assert!(prime().is_err());
    assert_originals_retained();
    state(|value| value.fail_persist = false);
    prime().unwrap();
    state(|value| { assert_eq!(value.persist_calls, [true, false, false]); assert_eq!(value.deleted.len(), 2); });
}

#[test]
fn current_normal_and_fast_values_are_persisted_before_legacy_cleanup() {
    for marker in [false, true] {
        setup(marker);
        state(|value| for key in KEYS { value.vault.insert(key.into(), format!("current-{key}")); });
        prime().unwrap();
        state(|value| {
            assert!(value.legacy_reads.is_empty());
            assert_eq!(value.deleted.len(), 2);
            for key in KEYS { assert_eq!(value.durable[key], format!("current-{key}")); }
        });
    }
}

#[test]
fn failed_persist_of_current_values_preserves_legacy_with_either_marker_state() {
    for marker in [false, true] {
        setup(marker);
        state(|value| {
            value.fail_persist = true;
            for key in KEYS { value.vault.insert(key.into(), format!("current-{key}")); }
        });
        assert!(prime().is_err());
        assert_originals_retained();
    }
}

#[test]
fn partial_recovery_only_cleans_the_confirmed_id_with_either_marker_state() {
    for marker in [false, true] {
        for unavailable in KEYS {
            setup(marker);
            state(|value| { value.legacy_read_errors.insert(unavailable.into()); });
            prime().unwrap();
            state(|value| {
                assert_eq!(value.persist_calls, [false]);
                assert_eq!(value.deleted.len(), 1);
                assert!(!value.deleted.iter().any(|key| key == unavailable));
                assert!(value.legacy.contains_key(unavailable));
                assert!(!value.durable.contains_key(unavailable));
            });
        }
    }
}

#[test]
fn truly_missing_normal_and_fast_records_never_get_cleanup_requests() {
    for marker in [false, true] {
        setup(marker);
        state(|value| value.legacy.clear());
        prime().unwrap();
        state(|value| { assert!(value.deleted.is_empty()); assert!(value.persist_calls.is_empty()); });
    }
}

#[test]
fn shared_physical_wallet_is_transferred_and_cleaned_only_once() {
    setup(true);
    state(|value| value.normal_ids.push(Registration { id: "alias".into(), source_wallet_id: Some("wallet".into()), role: Some("fast".into()) }));
    prime().unwrap();
    state(|value| assert_eq!(value.deleted.iter().filter(|key| key.as_str() == "normal:wallet").count(), 1));
}
