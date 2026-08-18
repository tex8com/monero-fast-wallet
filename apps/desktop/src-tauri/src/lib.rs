mod app_vault;
mod community;
mod community_preferences;
mod compute_preferences;
mod derivation_performance;
mod desktop_notifications;
mod diagnostics;
mod enthusiast_v1;
mod fast_wallet;
mod fast_wallet_enrollment;
mod linux_notification_agent;
mod mfw_name_resolver;
mod mfw_names;
mod native_wallet;
mod node_settings;
mod platform_auth;
mod release_features;
mod secure_store;
mod security_settings;
pub mod tor_transport;
mod wallet_core;
mod wallet_registry;
mod windows_notification_agent;

use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{Condvar, Mutex, MutexGuard, OnceLock, TryLockError},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WalletCoreStatus {
    linked: bool,
    release_ready: bool,
    core_tree: &'static str,
    backend: &'static str,
    message: &'static str,
    product_core_abi: u32,
    product_core_schema_sha256: &'static str,
    diagnostic_registry_sha256: &'static str,
    app_vault_state_schema_sha256: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputeBackendStatus {
    preference: String,
    active_backend: String,
    gpu_available: bool,
    gpu_kind: String,
    device_name: String,
    device_count: i32,
    self_test_passed: bool,
    cpu_fallback: bool,
    last_error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FastWalletDiagnosticIntegrity {
    configured_count: usize,
    hosted_count: usize,
    missing_credential_count: usize,
    invalid_assignment_count: usize,
}

struct NativeWalletState(Mutex<native_wallet::NativeWallet>);

/// The C++ engine serializes individual wallet operations itself, but the Rust
/// host also protects the FFI wrapper.  Measuring this wait is essential: a
/// daemon connection may legitimately take seconds, but it must never be
/// mistaken for a slow renderer or biometric operation.
fn lock_native_wallet<'a>(
    app: &AppHandle,
    state: &'a NativeWalletState,
    operation: &'static str,
) -> Result<MutexGuard<'a, native_wallet::NativeWallet>, String> {
    let started = Instant::now();
    let guard = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?;
    diagnostics::record(
        app,
        "wallet.native-lock-acquired",
        &[
            ("operation", operation.to_owned()),
            ("waitMs", started.elapsed().as_millis().to_string()),
        ],
    );
    Ok(guard)
}

/// Snapshots are cosmetic refreshes.  They must never wait behind a slow DNS
/// or daemon handshake: the last known view stays on screen and the next
/// timer tick tries again.  Mutating wallet operations still use the blocking
/// lock deliberately so their native state change remains serialized.
fn try_lock_native_wallet<'a>(
    app: &AppHandle,
    state: &'a NativeWalletState,
    operation: &'static str,
) -> Result<MutexGuard<'a, native_wallet::NativeWallet>, String> {
    match state.0.try_lock() {
        Ok(guard) => {
            diagnostics::record_sampled(
                app,
                "wallet.native-lock-acquired",
                operation,
                60,
                &[
                    ("operation", operation.to_owned()),
                    ("waitMs", "0".to_owned()),
                ],
            );
            Ok(guard)
        }
        Err(TryLockError::WouldBlock) => {
            diagnostics::record(
                app,
                "wallet.native-lock-busy",
                &[("operation", operation.to_owned())],
            );
            Err("Wallet is connecting in the background.".to_owned())
        }
        Err(TryLockError::Poisoned(_)) => Err("Native wallet is busy.".to_owned()),
    }
}
/// Native wallet IDs are intentionally process-local. Only this in-memory map
/// associates a persisted, non-secret registration with its open native session.
struct WalletSessionState(Mutex<HashMap<String, String>>);

#[derive(Default)]
struct WalletSessionRecoveryRegistry {
    generations: HashMap<String, u64>,
    reopen_attempts: HashMap<String, u64>,
    in_flight: HashSet<String>,
    last_outcomes: HashMap<String, (u64, Result<u64, String>)>,
}

/// Serializes recovery per physical wallet container. Multiple renderer polls
/// that discover the same stale native handle wait for one reopen and receive
/// its one result; they can never create parallel Core sessions.
struct WalletSessionRecoveryState {
    registry: Mutex<WalletSessionRecoveryRegistry>,
    completed: Condvar,
    diagnostic_salt: [u8; 32],
}

enum WalletSessionRecoveryClaim {
    Leader {
        attempt: u64,
    },
    Completed {
        attempt: u64,
        outcome: Result<u64, String>,
    },
}

impl WalletSessionRecoveryState {
    fn new() -> Self {
        let mut diagnostic_salt = [0_u8; 32];
        getrandom::getrandom(&mut diagnostic_salt)
            .expect("operating-system randomness is required for session diagnostics");
        Self {
            registry: Mutex::new(WalletSessionRecoveryRegistry::default()),
            completed: Condvar::new(),
            diagnostic_salt,
        }
    }

    fn diagnostic_digest(&self, registration_id: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.diagnostic_salt);
        hasher.update(registration_id.as_bytes());
        hex::encode(&hasher.finalize()[..12])
    }

    fn observed_attempt(&self, recovery_key: &str) -> Result<u64, String> {
        self.registry
            .lock()
            .map_err(|_| "Wallet recovery state is busy.".to_owned())
            .map(|state| {
                state
                    .reopen_attempts
                    .get(recovery_key)
                    .copied()
                    .unwrap_or(0)
            })
    }

    /// Claims a reopen after a caller observed a stale native handle. If a
    /// different caller completed recovery between that observation and this
    /// claim, return its result instead of opening the same container twice.
    fn claim_after_stale(
        &self,
        recovery_key: &str,
        observed_attempt: u64,
    ) -> Result<WalletSessionRecoveryClaim, String> {
        let mut state = self
            .registry
            .lock()
            .map_err(|_| "Wallet recovery state is busy.".to_owned())?;
        loop {
            let current_attempt = state
                .reopen_attempts
                .get(recovery_key)
                .copied()
                .unwrap_or(0);
            if state.in_flight.contains(recovery_key) {
                state = self
                    .completed
                    .wait(state)
                    .map_err(|_| "Wallet recovery state is busy.".to_owned())?;
                continue;
            }
            if current_attempt > observed_attempt {
                let outcome = state
                    .last_outcomes
                    .get(recovery_key)
                    .filter(|(attempt, _)| *attempt == current_attempt)
                    .map(|(_, outcome)| outcome.clone())
                    .ok_or_else(|| "Wallet session recovery result is unavailable.".to_owned())?;
                return Ok(WalletSessionRecoveryClaim::Completed {
                    attempt: current_attempt,
                    outcome,
                });
            }
            let attempt = current_attempt.saturating_add(1);
            state
                .reopen_attempts
                .insert(recovery_key.to_owned(), attempt);
            state.in_flight.insert(recovery_key.to_owned());
            return Ok(WalletSessionRecoveryClaim::Leader { attempt });
        }
    }

    fn finish(
        &self,
        recovery_key: &str,
        attempt: u64,
        outcome: Result<u64, String>,
    ) -> Result<(), String> {
        {
            let mut state = self
                .registry
                .lock()
                .map_err(|_| "Wallet recovery state is busy.".to_owned())?;
            state.in_flight.remove(recovery_key);
            state
                .last_outcomes
                .insert(recovery_key.to_owned(), (attempt, outcome));
        }
        self.completed.notify_all();
        Ok(())
    }
}

/// Copy a native session ID without allowing the mutex guard to escape into a
/// caller expression. In particular, callers may safely invoke helpers that
/// lock the session map again after this function returns.
fn wallet_session_id(
    sessions: &WalletSessionState,
    registration_id: &str,
) -> Result<Option<String>, String> {
    let open_sessions = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?;
    Ok(open_sessions.get(registration_id).cloned())
}

fn ledger_hardware_session_key(source_registration_id: &str) -> String {
    format!("__ledger-signing-session:{source_registration_id}")
}

fn bind_ledger_session_ids(
    open_sessions: &mut HashMap<String, String>,
    registry: &wallet_registry::WalletRegistry,
    source: &wallet_registry::RegisteredWallet,
    companion: &wallet_registry::RegisteredWallet,
    companion_native_id: &str,
    hardware_native_id: Option<&str>,
    preserve_hardware_for_reconciliation: bool,
) {
    if let Some(hardware_native_id) = hardware_native_id {
        if preserve_hardware_for_reconciliation && hardware_native_id != companion_native_id {
            // Keep the signing session out of the renderer-visible wallet map.
            // The source registration already reads through the companion, but
            // the first key-image reconciliation still needs the live Ledger.
            open_sessions.insert(
                ledger_hardware_session_key(&source.id),
                hardware_native_id.to_owned(),
            );
        } else {
            open_sessions.remove(&ledger_hardware_session_key(&source.id));
            open_sessions.retain(|_, native_id| native_id != hardware_native_id);
        }
    }
    open_sessions.insert(companion.id.clone(), companion_native_id.to_owned());
    open_sessions.insert(source.id.clone(), companion_native_id.to_owned());
    for wallet in &registry.wallets {
        if wallet.kind == "hardware"
            && wallet.source_wallet_id.as_deref() == Some(source.id.as_str())
        {
            open_sessions.insert(wallet.id.clone(), companion_native_id.to_owned());
        }
    }
}

fn physical_registration_id(registration: &wallet_registry::RegisteredWallet) -> &str {
    if registration.kind == "hardware" && registration.role.as_deref() == Some("fast") {
        registration
            .source_wallet_id
            .as_deref()
            .unwrap_or(&registration.id)
    } else {
        &registration.id
    }
}

/// Resolve a process-local native handle by physical wallet container, not by
/// renderer registration. Ledger account 0 and its reserved Fast account 1
/// are separate logical views of one wallet file and must never create two
/// native scanners for that file.
fn shared_native_session_for_physical_registration(
    registry: &wallet_registry::WalletRegistry,
    sessions: &HashMap<String, String>,
    target_physical_registration_id: &str,
) -> Option<String> {
    sessions.iter().find_map(|(registration_id, native_id)| {
        registry
            .wallets
            .iter()
            .find(|wallet| wallet.id == *registration_id)
            .filter(|wallet| physical_registration_id(wallet) == target_physical_registration_id)
            .map(|_| native_id.clone())
    })
}
/// A native session must configure its daemon only once. Pre-opened wallets
/// intentionally have no entry until the user selects them for the first time.
struct WalletSyncState(Mutex<HashSet<String>>);
/// The Core owns one serialized native engine. Keep at most one native
/// configuration operation in flight, but retain every queued wallet: all
/// local wallets on the active network must join background synchronization
/// after global unlock. The patched C++ WalletEngine is the one-transport
/// coordinator; this host queue only serializes the short legacy ABI calls
/// that configure and join it. Selection never discards another scanner.
struct NodeSyncState(Mutex<NodeSyncQueue>);

#[derive(Default)]
struct NodeSyncQueue {
    active: bool,
    pending: VecDeque<(String, String)>,
}
/// Only one local-session warming pass may run after an app unlock. The pass
/// never connects to a node and releases this marker even when an item fails.
struct WalletWarmState(Mutex<bool>);
/// Fast Wallet sessions are isolated from the active normal-wallet mapping.
/// Their renderer IDs are process-local and never identify a wallet file.
struct FastWalletSessionState(Mutex<HashMap<String, String>>);
/// Assignment renewal is background maintenance. A single-flight marker keeps
/// repeated renderer list refreshes from launching duplicate network work.
struct FastWalletMaintenanceState(Mutex<bool>);
/// A Ledger request can block while the user approves it on-device. Keep an
/// explicit per-Ledger in-flight marker so repeated renderer clicks never
/// create parallel sessions or repeated Export view key prompts.
struct LedgerViewKeyExportState(Mutex<HashSet<String>>);
/// `true` means the app is locked.  This is intentionally process-local: the
/// durable secret stays in Keychain/Credential Manager/libsecret, while every
/// native wallet session is closed on lock.
struct AppProtectionState(Mutex<bool>);
/// Native, process-local app session. Renderer activity may extend the session,
/// but only native code can decide that the configured inactivity deadline has
/// elapsed and lock every wallet at once.
struct AppSessionSecurityState(Mutex<AppSessionSecurity>);

struct AppSessionSecurity {
    last_user_activity: Instant,
    auto_lock_seconds: u64,
}
/// Review data is captured from the native prepare result and renderer request
/// once, then consumed exactly once at commit. The renderer cannot replace the
/// reviewed recipient, amount, or fee by submitting only a pending ID.
struct PendingTransactionApprovalState(Mutex<HashMap<String, PendingTransactionApproval>>);
#[derive(Clone)]
struct PendingTransactionApproval {
    wallet_id: String,
    address: String,
    amount_atomic: String,
    fee_atomic: String,
    expires_at: u64,
    mfw: Option<MfwPendingApproval>,
}
#[derive(Clone)]
struct MfwPendingApproval {
    record_id: String,
    kind: String,
    years: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppProtectionStatus {
    configured: bool,
    locked: bool,
    mode: Option<String>,
    password_configured: bool,
    system_auth: platform_auth::SystemAuthStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoLockSettingsResponse {
    auto_lock_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAutoLockTimeoutInput {
    auto_lock_seconds: u64,
}
#[derive(Debug, Deserialize)]
struct AppProtectionPasswordInput {
    password: String,
}
#[derive(Debug, Deserialize)]
struct AppProtectionModeInput {
    mode: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    current_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWalletInput {
    wallet_name: String,
    password: String,
    language: Option<String>,
    network: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreWalletNativeInput {
    wallet_name: String,
    network: String,
    restore_height: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreFastWalletNativeInput {
    label: String,
    network: String,
    restore_height: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWalletInput {
    wallet_name: String,
    password: String,
    network: String,
    restore_height: Option<u64>,
    #[serde(default)]
    defer_sync: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WalletUiDiagnosticInput {
    event: String,
    elapsed_ms: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletOpenCredentialInput {
    wallet_name: String,
    network: String,
    restore_height: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateHardwareWalletInput {
    wallet_name: String,
    password: String,
    network: String,
    device_name: Option<String>,
    restore_height: Option<u64>,
    subaddress_lookahead: Option<String>,
    account_index: Option<u32>,
    role: Option<String>,
    create_fast: Option<bool>,
    defer_sync: Option<bool>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnableLedgerReadOnlyInput {
    source_wallet_id: String,
    source_registration_id: String,
    restore_height: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateLedgerReadOnlyFromDeviceInput {
    source_registration_id: String,
    restore_height: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReconcileLedgerBalanceInput {
    source_registration_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHardwareViewKeyExport {
    address: String,
    private_view_key: String,
    network: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WalletOperationResponse {
    wallet_id: String,
    wallet: wallet_registry::RegisteredWallet,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WalletSessionRecoveryResponse {
    wallet_id: String,
    wallet: wallet_registry::RegisteredWallet,
    session_generation: u64,
    reopen_attempt: u64,
    reopened: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredWalletView {
    #[serde(flatten)]
    wallet: wallet_registry::RegisteredWallet,
    is_open: bool,
    is_active: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredWalletSnapshot {
    registration_id: String,
    snapshot: String,
    /// True only when a Ledger parent is being represented by its encrypted
    /// local read-only companion. A snapshot read directly from an attached
    /// Ledger already contains the hardware-derived spent state and must not
    /// be hidden behind the companion reconciliation gate.
    uses_ledger_read_only: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletIdInput {
    wallet_id: String,
    account_index: Option<u32>,
    address_index: Option<u32>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationIdInput {
    registration_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateRecipientAddressInput {
    address: String,
    network: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyMfwNameRecordAddressInput {
    record_payload_hex: String,
    expected_name: String,
    network: String,
    signing_owner_public_key_hex: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveMfwNameInput {
    name: String,
    network: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckMfwNameAvailabilityInput {
    name: String,
    network: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareMfwNameRegistrationInput {
    wallet_id: String,
    wallet_registration_id: String,
    name: String,
    address: String,
    network: String,
    years: u32,
    priority: Option<String>,
    account_index: Option<u32>,
    address_index: Option<u32>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareMfwNameClaimInput {
    wallet_id: String,
    wallet_registration_id: String,
    name_id: String,
    priority: Option<String>,
    account_index: Option<u32>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareMfwNameTransitionInput {
    wallet_id: String,
    wallet_registration_id: String,
    name_id: String,
    operation: String,
    address: Option<String>,
    years: Option<u32>,
    priority: Option<String>,
    account_index: Option<u32>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportMfwNameRecoveryInput {
    name_id: String,
    recovery_password: String,
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMfwNameLocalInput {
    name_id: String,
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportMfwNameRecoveryInput {
    wallet_registration_id: String,
    name: String,
    network: String,
    recovery_password: String,
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshMfwNameInput {
    wallet_id: Option<String>,
    name_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMfwPrepared {
    owner_public_key_hex: String,
    owner_private_key_hex: String,
    commit_salt_hex: String,
    prepared_transaction: serde_json::Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MfwPreparedResponse {
    name_id: String,
    canonical_name: String,
    kind: String,
    years: u32,
    recovery_export_required: bool,
    prepared_transaction: serde_json::Value,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameWalletInput {
    wallet_id: String,
    display_name: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveRegisteredWalletInput {
    wallet_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketBackupInput {
    kind: String,
    timeframe: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubaddressInput {
    wallet_id: String,
    label: String,
    account_index: Option<u32>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareTransactionInput {
    wallet_id: String,
    registration_id: Option<String>,
    address: String,
    amount_atomic: String,
    payment_id: Option<String>,
    priority: Option<String>,
    account_index: Option<u32>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitTransactionInput {
    wallet_id: String,
    registration_id: Option<String>,
    pending_id: String,
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresentRecoverySeedInput {
    wallet_id: String,
    registration_id: String,
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HardwareAddressInput {
    wallet_id: String,
    account_index: Option<u32>,
    address_index: Option<u32>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonInput {
    wallet_id: String,
    address: String,
    trusted: bool,
    use_ssl: bool,
    username: Option<String>,
    password: String,
    #[serde(rename = "proxyAddress")]
    _proxy_address: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeSettingsInput {
    wallet_id: Option<String>,
    mode: String,
    network: String,
    daemon_address: String,
    grpc_endpoint: String,
    trusted: bool,
    use_ssl: bool,
    username: String,
    password: String,
    proxy_address: String,
    clear_password: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionDiagnosticsInput {
    network: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectivityStatusInput {
    network: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRouteProbe {
    connected: bool,
    endpoint: String,
    elapsed_ms: Option<u128>,
    error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRoutesDiagnostic {
    tor: ConnectionRouteProbe,
    clearnet: ConnectionRouteProbe,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectivityRouteState {
    phase: String,
    connected: bool,
    endpoint: String,
    checked_at_ms: u64,
    elapsed_ms: Option<u128>,
    error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectivityStatus {
    tor: ConnectivityRouteState,
    clearnet: ConnectivityRouteState,
}
static CLEARNET_CONNECTIVITY: OnceLock<Mutex<HashMap<String, ConnectivityRouteState>>> =
    OnceLock::new();
static TOR_CONNECTIVITY: OnceLock<Mutex<HashMap<String, ConnectivityRouteState>>> = OnceLock::new();
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFastWalletInput {
    source_wallet_id: String,
    source_registration_id: String,
    label: String,
    password: String,
    restore_height: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FastWalletEnableInput {
    identity_id: String,
    scanner_url: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LedgerFastWalletEnableInput {
    identity_id: String,
    source_wallet_id: String,
    scanner_url: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FastWalletIdInput {
    identity_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptedFastWalletAlertsInput {
    identity_id: String,
    worker: String,
    #[serde(default)]
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairPrivateFastWalletWorkerInput {
    worker_qr: String,
    network: String,
    #[serde(default)]
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListCommunityFastWalletWorkersInput {
    network: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectCommunityFastWalletWorkerInput {
    worker: fast_wallet_enrollment::CommunityWorkerView,
    network: String,
    #[serde(default)]
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizedFastWalletIdInput {
    identity_id: String,
    #[serde(default)]
    app_password: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizedAlertsInput {
    #[serde(default)]
    app_password: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FastWalletOpenResponse {
    wallet_id: String,
    wallet: fast_wallet::FastWalletRecord,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeFastWalletIdentity {
    id: String,
    label: String,
    address: String,
    network: String,
    restore_height: String,
    derivation_index: String,
    scanner_status: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeFastWalletRegistrationPayload {
    identity: NativeFastWalletIdentity,
    private_view_key: String,
}
#[derive(Debug, Deserialize)]
struct ScannerWatchResponse {
    identity_id: String,
    status: String,
    scanner_status: String,
    network: String,
    restore_height: u64,
    last_scanned_height: u64,
    notifications_enabled: bool,
}
#[tauri::command]
async fn notification_installation_status(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    require_app_unlocked(&protection)?;
    desktop_notifications::reconcile_gateway(&app).await
}

#[tauri::command]
async fn request_notification_installation(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: desktop_notifications::RequestNotificationInstallationInput,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    require_app_unlocked(&protection)?;
    desktop_notifications::request_installation(&app, input)?;
    desktop_notifications::reconcile_gateway(&app).await
}

#[tauri::command]
async fn disable_notification_installation(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    require_app_unlocked(&protection)?;
    let current = desktop_notifications::status(&app)?;
    if current.installation.gateway_status == "active" {
        fast_wallet_enrollment::disable_delivery(&app).await?;
    }
    desktop_notifications::disable_installation(&app)
}

#[tauri::command]
fn consume_pending_notification_open(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<Option<desktop_notifications::NotificationEvent>, String> {
    require_app_unlocked(&protection)?;
    desktop_notifications::consume_pending_open(&app)
}

#[tauri::command]
fn background_notification_agent_config_path(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<Option<String>, String> {
    require_app_unlocked(&protection)?;
    desktop_notifications::background_agent_config_path(&app)
}

#[tauri::command]
fn wallet_core_status() -> WalletCoreStatus {
    let linked = wallet_core::is_linked();
    WalletCoreStatus {
        linked,
        release_ready: linked,
        core_tree: env!("TEX8_DESKTOP_MONERO_CORE_TREE"),
        backend: if linked {
            "Forked Monero libwallet_api / wallet2"
        } else {
            "WalletEngine shell (Monero library not linked)"
        },
        message: if linked {
            "The native Monero WalletEngine is linked in this build."
        } else {
            "This development shell cannot create, restore, open, or sign a wallet until it is linked to the pinned forked Monero libwallet_api."
        },
        product_core_abi: mfw_product_core::mfw_product_core_abi_version(),
        product_core_schema_sha256: mfw_product_core::product_core_schema_sha256(),
        diagnostic_registry_sha256: mfw_product_core::product_core_diagnostic_registry_sha256(),
        app_vault_state_schema_sha256: mfw_product_core::app_vault_state_schema_sha256(),
    }
}

fn parse_compute_backend_status(value: &str) -> Result<ComputeBackendStatus, String> {
    let status: ComputeBackendStatus = serde_json::from_str(value)
        .map_err(|_| "Native compute backend returned an invalid status.".to_owned())?;
    compute_preferences::validate(&status.preference)?;
    if !matches!(
        status.active_backend.as_str(),
        "cpu" | "cpu-fallback" | "metal" | "cuda"
    ) || !matches!(status.gpu_kind.as_str(), "" | "metal" | "cuda")
        || status.device_count < 0
        || status.self_test_passed != status.gpu_available
    {
        return Err("Native compute backend returned an unsafe status.".to_owned());
    }
    if !status.cpu_fallback {
        return Err("Native compute backend disabled its required CPU fallback.".to_owned());
    }
    Ok(status)
}

#[tauri::command]
fn compute_backend_status(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
) -> Result<ComputeBackendStatus, String> {
    require_app_unlocked(&protection)?;
    let native = lock_native_wallet(&app, &state, "compute-backend-status")?;
    parse_compute_backend_status(&native.compute_backend_status()?)
}

#[tauri::command]
fn set_compute_backend(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    preference: String,
) -> Result<ComputeBackendStatus, String> {
    require_app_unlocked(&protection)?;
    compute_preferences::validate(&preference)?;
    // A damaged preference file must not trap the user permanently. This
    // update is already authenticated by the app lock, so repair from the
    // safest previous policy (CPU-only) and atomically store the new choice.
    let previous = compute_preferences::load(&app).unwrap_or_else(|_| "cpu".to_owned());
    let native = lock_native_wallet(&app, &state, "set-compute-backend")?;
    let status = parse_compute_backend_status(&native.set_compute_backend(&preference)?)?;
    if let Err(error) = compute_preferences::save(&app, &preference) {
        let _ = native.set_compute_backend(&previous);
        return Err(error);
    }
    diagnostics::record(
        &app,
        "wallet.compute-backend-updated",
        &[("preference", preference)],
    );
    Ok(status)
}

#[tauri::command]
async fn derivation_performance(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<derivation_performance::DerivationPerformance, String> {
    require_app_unlocked(&protection)?;
    let background_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Recheck after scheduling so locking the app while this job waited
        // cannot start a new native operation from a stale authorization.
        let protection = background_app.state::<AppProtectionState>();
        require_app_unlocked(&protection)?;
        if let Ok(Some(cached)) = derivation_performance::load(&background_app) {
            return Ok(cached);
        }

        // The renderer receives only the final public rate. The bounded native
        // benchmark runs behind the wallet mutex and therefore cannot overlap
        // a native wallet operation or consume a real view key by accident.
        let state = background_app.state::<NativeWalletState>();
        let native = lock_native_wallet(&background_app, &state, "derivation-performance")?;
        let result = derivation_performance::parse(&native.benchmark_derivation_performance()?)?;
        drop(native);
        if let Err(error) = derivation_performance::save(&background_app, &result) {
            diagnostics::record(
                &background_app,
                "wallet.derivation-performance-cache-failed",
                &[("outcome", "error".to_owned())],
            );
            eprintln!("derivation performance cache failed: {error}");
        }
        Ok(result)
    })
    .await
    .map_err(|_| "The device performance task stopped unexpectedly.".to_owned())?
}

#[tauri::command]
async fn diagnostic_derivation_performance(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<derivation_performance::DerivationPerformance, String> {
    require_app_unlocked(&protection)?;
    let background_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let protection = background_app.state::<AppProtectionState>();
        require_app_unlocked(&protection)?;
        let state = background_app.state::<NativeWalletState>();
        let native =
            lock_native_wallet(&background_app, &state, "diagnostic-derivation-performance")?;
        let result = derivation_performance::parse(&native.benchmark_derivation_performance()?)?;
        drop(native);
        let _ = derivation_performance::save(&background_app, &result);
        Ok(result)
    })
    .await
    .map_err(|_| "The diagnostic performance task stopped unexpectedly.".to_owned())?
}

#[tauri::command]
fn diagnostic_secure_storage_roundtrip(
    protection: State<'_, AppProtectionState>,
) -> Result<bool, String> {
    require_app_unlocked(&protection)?;
    let key = format!("diagnostic-roundtrip-{}", now());
    let expected = "bounded-diagnostic-value";
    app_vault::put_secret(&key, expected)?;
    let read_result = app_vault::get_secret(&key);
    let delete_result = app_vault::delete_secret(&key);
    let mut value =
        read_result?.ok_or_else(|| "AppVault did not return the diagnostic value.".to_owned())?;
    let matches = value == expected;
    value.zeroize();
    delete_result?;
    Ok(matches)
}

#[tauri::command]
fn diagnostic_fast_wallet_integrity(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<FastWalletDiagnosticIntegrity, String> {
    require_app_unlocked(&protection)?;
    let records = fast_wallet::list(&app)?;
    let current_time = now();
    let mut hosted_count = 0_usize;
    let mut missing_credential_count = 0_usize;
    let mut invalid_assignment_count = 0_usize;
    for record in &records {
        match secure_store::load_fast_wallet_password(&record.id) {
            Ok(Some(mut secret)) => secret.zeroize(),
            _ => missing_credential_count = missing_credential_count.saturating_add(1),
        }
        let Some(handle) = record.assignment_handle.as_deref() else {
            continue;
        };
        hosted_count = hosted_count.saturating_add(1);
        let local_assignment = fast_wallet_enrollment::load_assignment(&record.id)?;
        let valid_handle = handle.len() == 64
            && handle
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        let metadata_valid = valid_handle
            && record.assignment_epoch.is_some_and(|value| value > 0)
            && record
                .assignment_expires_at
                .is_some_and(|value| value > current_time)
            && record
                .watch_message_id
                .as_ref()
                .is_some_and(|value| !value.is_empty());
        let secure_state_matches = local_assignment.as_ref().is_some_and(|assignment| {
            assignment.assignment_handle == handle
                && Some(assignment.assignment_epoch) == record.assignment_epoch
                && Some(assignment.expires_at) == record.assignment_expires_at
        });
        if !metadata_valid || !secure_state_matches {
            invalid_assignment_count = invalid_assignment_count.saturating_add(1);
        }
    }
    Ok(FastWalletDiagnosticIntegrity {
        configured_count: records.len(),
        hosted_count,
        missing_credential_count,
        invalid_assignment_count,
    })
}

#[tauri::command]
async fn diagnostic_fast_wallet_worker(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    identity_id: String,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    fast_wallet::validate_id(&identity_id)?;
    let record = fast_wallet::get(&app, &identity_id)?;
    let assignment = fast_wallet_enrollment::load_assignment(&identity_id)?
        .ok_or_else(|| "The Fast Wallet has no protected assignment state.".to_owned())?;
    let worker =
        fast_wallet_enrollment::worker_for_assignment(&record.network, &assignment, now()).await?;
    Ok(hex::encode(worker.descriptor.worker_root_id()))
}

#[tauri::command]
async fn fetch_private_service(input: MarketBackupInput) -> Result<String, String> {
    let url = private_service_url(&input.kind, input.timeframe.as_deref())?;
    let timeout = if input.kind == "news" { 20 } else { 12 };
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .user_agent("Monero-Fast-Wallet-Desktop/0.1")
        .proxy(tor_transport::proxy()?)
        .build()
        .map_err(|_| "Private service client could not be initialized.".to_owned())?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "Private service could not be reached through Tor.".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "Private service returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    response
        .text()
        .await
        .map_err(|_| "Private service returned an invalid response.".to_owned())
}

/// Persist only fixed, privacy-safe renderer lifecycle markers.  Wallet names,
/// addresses, identifiers, credentials, and user-entered text are deliberately
/// not accepted here.
#[tauri::command]
fn wallet_ui_diagnostic(app: AppHandle, input: WalletUiDiagnosticInput) -> Result<(), String> {
    const ALLOWED_EVENTS: &[&str] = &[
        "wallet-list-reload-started",
        "wallet-list-reload-completed",
        "wallet-list-reload-failed",
        "wallet-switch-selected",
        "wallet-switch-activate-started",
        "wallet-switch-activate-completed",
        "wallet-switch-open-flow-shown",
        "wallet-switch-core-open-started",
        "wallet-switch-core-open-completed",
        "wallet-switch-core-open-failed",
        "wallet-switch-ui-rendered",
        "wallet-switch-completed",
        "wallet-switch-failed",
    ];
    if !ALLOWED_EVENTS.contains(&input.event.as_str()) {
        return Err("Unsupported wallet UI diagnostic event.".to_owned());
    }
    let mut fields = vec![("event", input.event)];
    if let Some(elapsed_ms) = input.elapsed_ms {
        fields.push(("elapsedMs", elapsed_ms.to_string()));
    }
    diagnostics::record(&app, "wallet.ui", &fields);
    Ok(())
}

#[tauri::command]
async fn ledger_transport_status(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let background_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Recheck after scheduling so a scan queued immediately before an app
        // lock cannot continue with stale authorization.
        let protection = background_app.state::<AppProtectionState>();
        require_app_unlocked(&protection)?;
        let started = Instant::now();
        diagnostics::record(&background_app, "ledger.ble-scan-started", &[]);
        let state = background_app.state::<NativeWalletState>();
        let native = lock_native_wallet(&background_app, &state, "ledger-ble-scan")?;
        let result = native.ledger_transport_status();
        diagnostics::record(
            &background_app,
            if result.is_ok() {
                "ledger.ble-scan-completed"
            } else {
                "ledger.ble-scan-failed"
            },
            &[("elapsedMs", started.elapsed().as_millis().to_string())],
        );
        result
    })
    .await
    .map_err(|_| "Ledger Bluetooth scan worker stopped unexpectedly.".to_owned())?
}

#[tauri::command]
fn store_wallet_password(
    protection: State<'_, AppProtectionState>,
    wallet_id: String,
    mut password: String,
) -> Result<(), String> {
    if let Err(error) = require_app_unlocked(&protection) {
        password.zeroize();
        return Err(error);
    }
    secure_store::store_wallet_password(&wallet_id, password)
}

#[tauri::command]
fn delete_wallet_password(
    protection: State<'_, AppProtectionState>,
    wallet_id: String,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    secure_store::delete_wallet_password(&wallet_id)
}

fn app_is_locked(state: &AppProtectionState) -> Result<bool, String> {
    state
        .0
        .lock()
        .map(|locked| *locked)
        .map_err(|_| "App protection state is busy.".to_owned())
}

fn require_app_unlocked(state: &AppProtectionState) -> Result<(), String> {
    if app_is_locked(state)? {
        return Err("Unlock Monero Fast Wallet before opening wallets.".to_owned());
    }
    Ok(())
}

/// Every successful global unlock begins a fresh inactivity window. Without
/// this native reset, an automatic system-auth unlock after a timeout could be
/// relocked immediately by the monitor using the expired previous deadline.
fn reset_app_session_activity(app: &AppHandle) -> Result<(), String> {
    app.state::<AppSessionSecurityState>()
        .0
        .lock()
        .map_err(|_| "App session security state is busy.".to_owned())?
        .last_user_activity = Instant::now();
    Ok(())
}

fn unlock_delay_seconds(failures: u32) -> u64 {
    mfw_product_core::app_vault::unlock_delay_seconds(failures)
}

fn require_fresh_app_password(password: &mut String) -> Result<(), String> {
    let result = (|| {
        if !secure_store::app_protection_configured()? {
            return Err("App protection is not configured on this device.".to_owned());
        }
        let (failures, blocked_until) = secure_store::load_app_unlock_throttle()?;
        let current_time = now();
        if blocked_until > current_time {
            return Err(format!(
                "Too many authorization attempts. Retry in {} seconds.",
                blocked_until - current_time
            ));
        }
        if !secure_store::verify_app_protection_password(password)? {
            let next_failures = failures.saturating_add(1);
            let delay = unlock_delay_seconds(next_failures);
            secure_store::store_app_unlock_throttle(
                next_failures,
                current_time.saturating_add(delay),
            )?;
            return Err(format!(
                "The app password is incorrect. Retry in {delay} seconds."
            ));
        }
        secure_store::clear_app_unlock_throttle()
    })();
    password.zeroize();
    result
}

async fn app_protection_snapshot(
    app: &AppHandle,
    protection: &AppProtectionState,
) -> Result<AppProtectionStatus, String> {
    if secure_store::diagnostic_automation_unlock_enabled() {
        if secure_store::load_app_protection_mode()?.is_none() {
            secure_store::store_app_protection_mode("system")?;
        }
        *protection
            .0
            .lock()
            .map_err(|_| "App protection state is busy.".to_owned())? = false;
        eprintln!("MONERO_DESKTOP_APP_PROTECTION diagnostic-automation-unlocked");
    }
    let mode = secure_store::load_app_protection_mode()?;
    if mode.as_deref() == Some("none") && app_is_locked(protection)? {
        secure_store::unlock_app_vault_with_system()?;
        reset_app_session_activity(app)?;
        *protection
            .0
            .lock()
            .map_err(|_| "App protection state is busy.".to_owned())? = false;
        migrate_and_prime_app_session_credentials(app)?;
        warm_registered_wallet_sessions_after_unlock(app.clone());
        eprintln!("MONERO_DESKTOP_APP_PROTECTION skipped-auto-unlocked");
    }
    let configured = mode.is_some();
    let system_auth = platform_auth::status().await;
    let password_configured = match mode.as_deref() {
        Some("password") => true,
        Some("system") => secure_store::app_protection_password_configured()?,
        _ => false,
    };
    Ok(AppProtectionStatus {
        configured,
        locked: !configured || app_is_locked(protection)?,
        mode,
        password_configured,
        system_auth,
    })
}

/// Move every readable per-wallet credential into the single process-wide
/// AppVault immediately after the one app authorization. The migration marker
/// and all imported credentials are one atomic generation. Missing records do
/// not block healthy wallets and keep the marker open for a later recovery.
fn migrate_and_prime_app_session_credentials(app: &AppHandle) -> Result<(), String> {
    let mut normal_ids = HashSet::new();
    let mut fast_ids = HashSet::new();
    let mut normal_loaded = 0usize;
    let mut fast_loaded = 0usize;
    let mut unavailable = 0usize;
    let mut all_accounted_for = true;
    let mut entries = Vec::<(String, String)>::new();
    let mut legacy_normal_cleanup = Vec::<String>::new();
    let mut legacy_fast_cleanup = Vec::<String>::new();
    let previously_committed = secure_store::app_vault_migration_committed()?;

    match wallet_registry::list(app) {
        Ok(registry) => {
            for registration in registry.wallets {
                let physical_id = registration
                    .source_wallet_id
                    .as_deref()
                    .filter(|_| registration.role.as_deref() == Some("fast"))
                    .unwrap_or(&registration.id)
                    .to_owned();
                if !normal_ids.insert(physical_id.clone()) {
                    continue;
                }
                match secure_store::load_wallet_password_current(&physical_id) {
                    Ok(Some(mut credential)) => {
                        credential.zeroize();
                        normal_loaded += 1;
                    }
                    Ok(None) if !previously_committed => {
                        match secure_store::load_legacy_wallet_password_current(&physical_id) {
                            Ok(Some(credential)) => {
                                entries.push((
                                    secure_store::wallet_app_vault_key(&physical_id)?,
                                    credential,
                                ));
                                legacy_normal_cleanup.push(physical_id);
                                normal_loaded += 1;
                            }
                            Ok(None) | Err(_) => {
                                unavailable += 1;
                                all_accounted_for = false;
                            }
                        }
                    }
                    Ok(None) | Err(_) => {
                        unavailable += 1;
                        all_accounted_for = false;
                    }
                }
            }
        }
        Err(_) => {
            unavailable += 1;
            all_accounted_for = false;
        }
    }

    match fast_wallet::list(app) {
        Ok(wallets) => {
            for wallet in wallets {
                if !fast_ids.insert(wallet.id.clone()) {
                    continue;
                }
                match secure_store::load_fast_wallet_password_current(&wallet.id) {
                    Ok(Some(mut credential)) => {
                        credential.zeroize();
                        fast_loaded += 1;
                    }
                    Ok(None) if !previously_committed => {
                        match secure_store::load_legacy_fast_wallet_password_current(&wallet.id) {
                            Ok(Some(credential)) => {
                                entries.push((
                                    secure_store::fast_wallet_app_vault_key(&wallet.id)?,
                                    credential,
                                ));
                                legacy_fast_cleanup.push(wallet.id);
                                fast_loaded += 1;
                            }
                            Ok(None) | Err(_) => {
                                unavailable += 1;
                                all_accounted_for = false;
                            }
                        }
                    }
                    Ok(None) | Err(_) => {
                        unavailable += 1;
                        all_accounted_for = false;
                    }
                }
            }
        }
        Err(_) => {
            unavailable += 1;
            all_accounted_for = false;
        }
    }

    if !previously_committed {
        if all_accounted_for {
            secure_store::commit_legacy_wallet_credentials(&entries)?;
        } else if !entries.is_empty() {
            secure_store::merge_legacy_wallet_credentials(&entries)?;
        }
    }

    // Deletion is deliberately after the authenticated AppVault write. If the
    // process stops here, the next unlock safely retries this idempotent step.
    for wallet_id in &legacy_normal_cleanup {
        let _ = secure_store::delete_legacy_wallet_password(wallet_id);
    }
    for wallet_id in &legacy_fast_cleanup {
        let _ = secure_store::delete_legacy_fast_wallet_password(wallet_id);
    }
    if previously_committed {
        for wallet_id in &normal_ids {
            let _ = secure_store::delete_legacy_wallet_password(wallet_id);
        }
        for wallet_id in &fast_ids {
            let _ = secure_store::delete_legacy_fast_wallet_password(wallet_id);
        }
    }

    for (_, value) in &mut entries {
        value.zeroize();
    }

    diagnostics::record(
        app,
        "security.session-credentials-primed",
        &[
            ("normalLoaded", normal_loaded.to_string()),
            ("fastLoaded", fast_loaded.to_string()),
            ("unavailable", unavailable.to_string()),
            (
                "migrationCommitted",
                secure_store::app_vault_migration_committed()?.to_string(),
            ),
        ],
    );
    Ok(())
}

struct WalletWarmPermit {
    app: AppHandle,
}

impl Drop for WalletWarmPermit {
    fn drop(&mut self) {
        if let Ok(mut warming) = self.app.state::<WalletWarmState>().0.lock() {
            *warming = false;
        }
    }
}

/// Open encrypted local wallet files in a bounded background pass after the
/// global app unlock. This performs no daemon configuration, refresh, DNS, or
/// device interaction. A selected warm wallet is therefore an in-memory ID
/// change; hardware wallets keep their explicit physical authorization flow.
fn warm_registered_wallet_sessions_after_unlock(app: AppHandle) {
    let should_start = app
        .state::<WalletWarmState>()
        .0
        .lock()
        .map(|mut warming| {
            if *warming {
                false
            } else {
                *warming = true;
                true
            }
        })
        .unwrap_or(false);
    if !should_start {
        diagnostics::record(&app, "wallet.warm-pass-already-running", &[]);
        return;
    }

    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _permit = WalletWarmPermit { app: app.clone() };
        let started = Instant::now();
        let mut opened = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;
        let mut sync_after_warm: Vec<(String, String)> = Vec::new();

        let registry = match wallet_registry::list(&app) {
            Ok(registry) => registry,
            Err(_) => {
                diagnostics::record(
                    &app,
                    "wallet.warm-pass-failed",
                    &[("stage", "registry".to_owned())],
                );
                return;
            }
        };
        let mut wallets = registry.wallets.clone();
        if let Some(active_id) = registry.active_wallet_id.as_ref() {
            wallets.sort_by_key(|wallet| usize::from(&wallet.id != active_id));
        }

        for registration in wallets {
            let protection_state = app.state::<AppProtectionState>();
            if app_is_locked(&protection_state).unwrap_or(true) {
                break;
            }
            let physical = match physical_registration_for_open(&app, &registration) {
                Ok(physical) if physical.kind != "hardware" => physical,
                Ok(_) => {
                    skipped += 1;
                    continue;
                }
                Err(_) => {
                    failed += 1;
                    continue;
                }
            };
            {
                let session_state = app.state::<WalletSessionState>();
                let mut sessions = match session_state.0.lock() {
                    Ok(sessions) => sessions,
                    Err(_) => {
                        failed += 1;
                        continue;
                    }
                };
                if sessions.contains_key(&registration.id) {
                    skipped += 1;
                    continue;
                }
                if let Some(native_id) = shared_native_session_for_physical_registration(
                    &registry,
                    &sessions,
                    &physical.id,
                ) {
                    sessions.insert(registration.id.clone(), native_id);
                    skipped += 1;
                    continue;
                }
            }
            let mut password = match secure_store::load_wallet_password_current(&physical.id) {
                Ok(Some(password)) => password,
                Ok(None) | Err(_) => {
                    failed += 1;
                    continue;
                }
            };
            let path = match wallet_path(&app, &physical.wallet_name) {
                Ok(path) => path,
                Err(_) => {
                    password.zeroize();
                    failed += 1;
                    continue;
                }
            };
            let network_code = match network(&physical.network) {
                Ok(network_code) => network_code,
                Err(_) => {
                    password.zeroize();
                    failed += 1;
                    continue;
                }
            };
            let native_state = app.state::<NativeWalletState>();
            let native = match lock_native_wallet(&app, &native_state, "wallet-warm") {
                Ok(native) => native,
                Err(_) => {
                    password.zeroize();
                    failed += 1;
                    continue;
                }
            };
            if app
                .state::<WalletSessionState>()
                .0
                .lock()
                .map(|sessions| sessions.contains_key(&registration.id))
                .unwrap_or(true)
            {
                password.zeroize();
                skipped += 1;
                continue;
            }
            match native.open(
                &path,
                &password,
                network_code,
                physical.restore_height.unwrap_or(0),
            ) {
                Ok(native_id) => {
                    let protection_state = app.state::<AppProtectionState>();
                    if app_is_locked(&protection_state).unwrap_or(true) {
                        let _ = native.close(&native_id, false);
                        password.zeroize();
                        break;
                    }
                    if let Ok(mut sessions) = app.state::<WalletSessionState>().0.lock() {
                        // Bind both the implementation-detail companion and
                        // the user-facing Ledger registration to the same
                        // native view-only session. Later logical entries
                        // (including the Ledger Fast Wallet) reuse it instead
                        // of reopening the wallet file or the device.
                        sessions.insert(physical.id.clone(), native_id.clone());
                        sessions.insert(registration.id, native_id.clone());
                        sync_after_warm.push((native_id, registration.network));
                        opened += 1;
                    } else {
                        failed += 1;
                    }
                }
                Err(_) => failed += 1,
            }
            password.zeroize();
        }

        for wallet in fast_wallet::list(&app).unwrap_or_default() {
            let protection_state = app.state::<AppProtectionState>();
            if app_is_locked(&protection_state).unwrap_or(true) {
                break;
            }
            if fast_wallet::require_independent_software(&wallet).is_err() {
                skipped += 1;
                continue;
            }
            if app
                .state::<FastWalletSessionState>()
                .0
                .lock()
                .map(|sessions| sessions.contains_key(&wallet.id))
                .unwrap_or(true)
            {
                skipped += 1;
                continue;
            }
            let mut password = match secure_store::load_fast_wallet_password_current(&wallet.id) {
                Ok(Some(password)) => password,
                Ok(None) | Err(_) => {
                    failed += 1;
                    continue;
                }
            };
            let path = match fast_wallet::wallet_path(&app, &wallet.id) {
                Ok(path) => path,
                Err(_) => {
                    password.zeroize();
                    failed += 1;
                    continue;
                }
            };
            let network_code = match network(&wallet.network) {
                Ok(network_code) => network_code,
                Err(_) => {
                    password.zeroize();
                    failed += 1;
                    continue;
                }
            };
            let native_state = app.state::<NativeWalletState>();
            let native = match lock_native_wallet(&app, &native_state, "fast-wallet-warm") {
                Ok(native) => native,
                Err(_) => {
                    password.zeroize();
                    failed += 1;
                    continue;
                }
            };
            match native.open(&path, &password, network_code, wallet.restore_height) {
                Ok(native_id) => {
                    let protection_state = app.state::<AppProtectionState>();
                    if app_is_locked(&protection_state).unwrap_or(true) {
                        let _ = native.close(&native_id, false);
                        password.zeroize();
                        break;
                    }
                    if let Ok(mut sessions) = app.state::<FastWalletSessionState>().0.lock() {
                        sessions.insert(wallet.id, native_id.clone());
                        sync_after_warm.push((native_id, wallet.network.clone()));
                        opened += 1;
                    } else {
                        failed += 1;
                    }
                }
                Err(_) => failed += 1,
            }
            password.zeroize();
        }

        // Wallet file opening is local-only. Once all available sessions are
        // warm, enqueue every scanner for background synchronization. The
        // scheduler serializes only Core configuration; it must never make
        // synchronization depend on which wallet card is currently visible.
        for (native_id, network_name) in sync_after_warm {
            schedule_wallet_sync(app.clone(), native_id, network_name);
        }

        diagnostics::record(
            &app,
            "wallet.warm-pass-complete",
            &[
                ("opened", opened.to_string()),
                ("skipped", skipped.to_string()),
                ("failed", failed.to_string()),
                ("elapsedMs", started.elapsed().as_millis().to_string()),
            ],
        );
    });
}

async fn require_fresh_app_authorization(
    app: AppHandle,
    password: &mut String,
    reason: &str,
) -> Result<(), String> {
    match secure_store::load_app_protection_mode()?.as_deref() {
        Some("password") => require_fresh_app_password(password),
        Some("system") => {
            if !password.is_empty() {
                return require_fresh_app_password(password);
            }
            password.zeroize();
            platform_auth::authenticate(app, reason).await
        }
        Some("none") => {
            password.zeroize();
            Ok(())
        }
        _ => {
            password.zeroize();
            Err("App protection is not configured on this device.".to_owned())
        }
    }
}

#[tauri::command]
async fn app_protection_status(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<AppProtectionStatus, String> {
    app_protection_snapshot(&app, &protection).await
}

#[tauri::command]
async fn retry_app_protection_status(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<AppProtectionStatus, String> {
    secure_store::retry_failed_secret_reads()?;
    eprintln!("MONERO_DESKTOP_APP_PROTECTION status-retry-requested");
    app_protection_snapshot(&app, &protection).await
}

#[tauri::command]
async fn set_app_protection_password(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: AppProtectionPasswordInput,
) -> Result<AppProtectionStatus, String> {
    let already_configured = secure_store::app_protection_configured()?;
    if already_configured && app_is_locked(&protection)? {
        input.password.zeroize();
        return Err("Unlock Monero Fast Wallet before changing the app password.".to_owned());
    }
    if input.password.chars().count() < 12 {
        input.password.zeroize();
        return Err("Use an app password with at least 12 characters.".to_owned());
    }
    secure_store::set_app_vault_recovery_password(&input.password)?;
    secure_store::store_app_protection_password(std::mem::take(&mut input.password))?;
    secure_store::store_app_protection_mode("password")?;
    secure_store::clear_app_unlock_throttle()?;
    reset_app_session_activity(&app)?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    migrate_and_prime_app_session_credentials(&app)?;
    warm_registered_wallet_sessions_after_unlock(app.clone());
    eprintln!("MONERO_DESKTOP_APP_PROTECTION configured");
    app_protection_snapshot(&app, &protection).await
}

#[tauri::command]
async fn verify_app_protection_password(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: AppProtectionPasswordInput,
) -> Result<AppProtectionStatus, String> {
    if !secure_store::app_protection_configured()? {
        input.password.zeroize();
        return Err("App protection is not configured on this device.".to_owned());
    }
    let (failures, blocked_until) = secure_store::load_app_unlock_throttle()?;
    let current_time = now();
    if blocked_until > current_time {
        input.password.zeroize();
        return Err(format!(
            "Too many unlock attempts. Retry in {} seconds.",
            blocked_until - current_time
        ));
    }
    let matches = secure_store::verify_app_protection_password(&input.password)?;
    if !matches {
        input.password.zeroize();
        let next_failures = failures.saturating_add(1);
        let delay = unlock_delay_seconds(next_failures);
        secure_store::store_app_unlock_throttle(next_failures, current_time.saturating_add(delay))?;
        eprintln!("MONERO_DESKTOP_APP_PROTECTION unlock-rejected");
        return Err(format!(
            "The app password is incorrect. Retry in {delay} seconds."
        ));
    }
    let vault_unlock = secure_store::unlock_app_vault_with_password(&input.password);
    input.password.zeroize();
    vault_unlock?;
    secure_store::clear_app_unlock_throttle()?;
    reset_app_session_activity(&app)?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    migrate_and_prime_app_session_credentials(&app)?;
    warm_registered_wallet_sessions_after_unlock(app.clone());
    eprintln!("MONERO_DESKTOP_APP_PROTECTION unlocked");
    app_protection_snapshot(&app, &protection).await
}

#[tauri::command]
async fn set_app_protection_mode(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: AppProtectionModeInput,
) -> Result<AppProtectionStatus, String> {
    let already_configured = secure_store::app_protection_configured()?;
    if already_configured && app_is_locked(&protection)? {
        input.password.zeroize();
        input.current_password.zeroize();
        return Err("Unlock Monero Fast Wallet before changing app protection.".to_owned());
    }
    let current_mode = secure_store::load_app_protection_mode()?;
    if already_configured {
        if let Err(error) = require_fresh_app_authorization(
            app.clone(),
            &mut input.current_password,
            "Confirm your identity before changing how this app is protected.",
        )
        .await
        {
            input.password.zeroize();
            return Err(error);
        }
    } else {
        input.current_password.zeroize();
    }
    match input.mode.as_str() {
        "password" => {
            if input.password.chars().count() < 12 {
                input.password.zeroize();
                return Err("Use an app password with at least 12 characters.".to_owned());
            }
            secure_store::set_app_vault_recovery_password(&input.password)?;
            secure_store::store_app_protection_password(std::mem::take(&mut input.password))?;
            secure_store::store_app_protection_mode("password")?;
        }
        "system" => {
            if !already_configured && input.password.chars().count() < 12 {
                input.password.zeroize();
                return Err(
                    "Use an app password with at least 12 characters as the recovery path."
                        .to_owned(),
                );
            }
            let system = platform_auth::status().await;
            if !system.available {
                input.password.zeroize();
                return Err(system.detail);
            }
            if current_mode.as_deref() != Some("system") {
                if let Err(error) = platform_auth::authenticate(
                    app.clone(),
                    "Confirm system sign-in for Monero Fast Wallet",
                )
                .await
                {
                    input.password.zeroize();
                    return Err(error);
                }
            }
            // Touch ID and Windows Hello already fall back to the operating
            // system's login credential. System protection therefore needs
            // no second app-specific recovery password. Existing password
            // recovery remains available after switching from password mode;
            // a first-run biometric setup creates only the system envelope.
            secure_store::unlock_app_vault_with_system()?;
            if !already_configured {
                secure_store::set_app_vault_recovery_password(&input.password)?;
                secure_store::store_app_protection_password(std::mem::take(&mut input.password))?;
            } else {
                input.password.zeroize();
            }
            secure_store::store_app_protection_mode("system")?;
        }
        "none" => {
            if already_configured {
                input.password.zeroize();
                return Err("App protection can only be skipped during initial setup.".to_owned());
            }
            input.password.zeroize();
            secure_store::unlock_app_vault_with_system()?;
            secure_store::store_app_protection_mode("none")?;
        }
        _ => {
            input.password.zeroize();
            return Err("Choose app password or secure system sign-in.".to_owned());
        }
    }
    secure_store::clear_app_unlock_throttle()?;
    reset_app_session_activity(&app)?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    migrate_and_prime_app_session_credentials(&app)?;
    warm_registered_wallet_sessions_after_unlock(app.clone());
    eprintln!("MONERO_DESKTOP_APP_PROTECTION mode={}", input.mode);
    app_protection_snapshot(&app, &protection).await
}

#[tauri::command]
async fn verify_system_auth(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<AppProtectionStatus, String> {
    if secure_store::load_app_protection_mode()?.as_deref() != Some("system") {
        return Err("Secure system sign-in is not configured for this app.".to_owned());
    }
    platform_auth::authenticate(app.clone(), "Unlock Monero Fast Wallet").await?;
    secure_store::unlock_app_vault_with_system()?;
    reset_app_session_activity(&app)?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    migrate_and_prime_app_session_credentials(&app)?;
    warm_registered_wallet_sessions_after_unlock(app.clone());
    eprintln!("MONERO_DESKTOP_APP_PROTECTION system-unlocked");
    app_protection_snapshot(&app, &protection).await
}

fn lock_app_native(
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    fast_sessions: &FastWalletSessionState,
    approvals: &PendingTransactionApprovalState,
    protection: &AppProtectionState,
    community_v1: &enthusiast_v1::CommunityV1State,
) -> Result<(), String> {
    // Locking is a one-way in-memory transition and must never read Keychain.
    // A Keychain authorization dialog itself removes window focus; reading
    // Keychain here would therefore create a self-sustaining prompt loop.
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = true;
    let wallet_ids = {
        let normal = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        let fast = fast_sessions
            .0
            .lock()
            .map_err(|_| "Fast Wallet session state is busy.".to_owned())?;
        normal
            .values()
            .chain(fast.values())
            .cloned()
            .collect::<HashSet<_>>()
    };
    let mut close_error = None;
    for wallet_id in wallet_ids {
        if let Err(error) = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .close(&wallet_id, true)
        {
            close_error.get_or_insert(error);
        }
    }
    sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .clear();
    fast_sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .clear();
    approvals
        .0
        .lock()
        .map_err(|_| "Transaction approval state is busy.".to_owned())?
        .clear();
    community_v1.clear_session();
    let cleared_credentials = secure_store::clear_session_secret_cache()?;
    eprintln!(
        "MONERO_DESKTOP_APP_PROTECTION locked secure_session_cache=cleared cleared_entries={cleared_credentials}"
    );
    if let Some(error) = close_error {
        return Err(format!(
            "Monero Fast Wallet is locked, but a wallet session reported: {error}"
        ));
    }
    Ok(())
}

#[tauri::command]
fn lock_app(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    fast_sessions: State<'_, FastWalletSessionState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    community_v1: State<'_, enthusiast_v1::CommunityV1State>,
) -> Result<(), String> {
    if secure_store::load_app_protection_mode()?.as_deref() == Some("none") {
        eprintln!("MONERO_DESKTOP_APP_PROTECTION lock-skipped mode=none");
        return Ok(());
    }
    let result = lock_app_native(
        &state,
        &sessions,
        &fast_sessions,
        &approvals,
        &protection,
        &community_v1,
    );
    if result.is_ok() {
        let _ = app.emit("app-lock-state-changed", true);
    }
    result
}

#[tauri::command]
fn record_app_user_activity(session: State<'_, AppSessionSecurityState>) -> Result<(), String> {
    session
        .0
        .lock()
        .map_err(|_| "App session security state is busy.".to_owned())?
        .last_user_activity = Instant::now();
    Ok(())
}

#[tauri::command]
fn auto_lock_settings(
    app: AppHandle,
    session: State<'_, AppSessionSecurityState>,
) -> Result<AutoLockSettingsResponse, String> {
    let settings = security_settings::load(&app)?;
    let mut current = session
        .0
        .lock()
        .map_err(|_| "App session security state is busy.".to_owned())?;
    current.auto_lock_seconds = settings.auto_lock_seconds;
    Ok(AutoLockSettingsResponse {
        auto_lock_seconds: settings.auto_lock_seconds,
    })
}

#[tauri::command]
fn set_auto_lock_timeout(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    session: State<'_, AppSessionSecurityState>,
    input: SetAutoLockTimeoutInput,
) -> Result<AutoLockSettingsResponse, String> {
    require_app_unlocked(&protection)?;
    let settings = security_settings::set_auto_lock_seconds(&app, input.auto_lock_seconds)?;
    let mut current = session
        .0
        .lock()
        .map_err(|_| "App session security state is busy.".to_owned())?;
    current.auto_lock_seconds = settings.auto_lock_seconds;
    current.last_user_activity = Instant::now();
    diagnostics::record(
        &app,
        "security.auto-lock-timeout-updated",
        &[("autoLockSeconds", settings.auto_lock_seconds.to_string())],
    );
    Ok(AutoLockSettingsResponse {
        auto_lock_seconds: settings.auto_lock_seconds,
    })
}

#[tauri::command]
fn create_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    mut input: CreateWalletInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let started = Instant::now();
    let wallet_name = next_wallet_file_name(&app, &input.wallet_name, "wallet")?;
    let wallet_network = input.network.clone();
    diagnostics::record(
        &app,
        "wallet.create-started",
        &[("network", wallet_network.clone())],
    );
    let mut password = wallet_password_or_generated(&mut input.password)?;
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .create(
            &wallet_path(&app, &wallet_name)?,
            &password,
            input.language.as_deref().unwrap_or("English"),
            network(&input.network)?,
        );
    let wallet_id = match result {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            password.zeroize();
            diagnostics::record(
                &app,
                "wallet.create-failed",
                &[
                    ("stage", "native-core".to_owned()),
                    ("elapsedMs", started.elapsed().as_millis().to_string()),
                ],
            );
            return Err(error);
        }
    };
    diagnostics::record(
        &app,
        "wallet.core-created",
        &[("elapsedMs", started.elapsed().as_millis().to_string())],
    );
    let result = finish_wallet_operation_with_password(
        &app,
        &state,
        &sessions,
        wallet_id,
        wallet_registry::software_wallet(&wallet_name, &wallet_network, None, "pending"),
        password,
        true,
    );
    diagnostics::record(
        &app,
        if result.is_ok() {
            "wallet.create-complete"
        } else {
            "wallet.create-failed"
        },
        &[
            (
                "stage",
                if result.is_ok() {
                    "complete".to_owned()
                } else {
                    "registration-or-sync".to_owned()
                },
            ),
            ("elapsedMs", started.elapsed().as_millis().to_string()),
        ],
    );
    result
}
#[tauri::command]
async fn restore_wallet_with_native_seed(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: RestoreWalletNativeInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let native_network = network(&input.network)?;
    let seed = Zeroizing::new(platform_auth::prompt_recovery_seed(app.clone()).await?);
    require_app_unlocked(&protection)?;
    let wallet_name = next_wallet_file_name(&app, &input.wallet_name, "wallet")?;
    let wallet_network = input.network.clone();
    let restore_height = input.restore_height.filter(|height| *height > 0);
    let path = wallet_path(&app, &wallet_name)?;
    let mut empty_password = String::new();
    let mut password = wallet_password_or_generated(&mut empty_password)?;
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .restore(
            &path,
            &password,
            seed.as_str(),
            "",
            native_network,
            input.restore_height.unwrap_or(0),
        );
    let wallet_id = match result {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            password.zeroize();
            return Err(error);
        }
    };
    finish_wallet_operation_with_password(
        &app,
        &state,
        &sessions,
        wallet_id,
        wallet_registry::software_wallet(&wallet_name, &wallet_network, restore_height, "verified"),
        password,
        true,
    )
}

#[tauri::command]
async fn restore_fast_wallet_with_native_seed(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, FastWalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: RestoreFastWalletNativeInput,
) -> Result<FastWalletOpenResponse, String> {
    require_app_unlocked(&protection)?;
    let native_network = network(&input.network)?;
    let seed = Zeroizing::new(platform_auth::prompt_recovery_seed(app.clone()).await?);
    require_app_unlocked(&protection)?;

    let derivation_index = fast_wallet::derivation_index(&app)?;
    let identity_id = fast_wallet::identity_id(derivation_index);
    let path = fast_wallet::wallet_path(&app, &identity_id)?;
    let label = if input.label.trim().is_empty() {
        "Restored Fast Wallet".to_owned()
    } else {
        input.label.trim().to_owned()
    };
    let restore_height = input
        .restore_height
        .filter(|height| *height > 0)
        .unwrap_or(0);
    let mut empty_password = String::new();
    let mut password = wallet_password_or_generated(&mut empty_password)?;

    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .restore(
            &path,
            &password,
            seed.as_str(),
            "",
            native_network,
            restore_height,
        );
    let wallet_id = match result {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            password.zeroize();
            remove_temporary_wallet_files(&path);
            return Err(error);
        }
    };

    let address = match state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .address(&wallet_id, 0, 0)
    {
        Ok(address) => address,
        Err(error) => {
            let _ = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&wallet_id, false);
            password.zeroize();
            remove_temporary_wallet_files(&path);
            return Err(error);
        }
    };

    if let Err(error) =
        secure_store::store_fast_wallet_password(&identity_id, std::mem::take(&mut password))
    {
        let _ = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .close(&wallet_id, false);
        remove_temporary_wallet_files(&path);
        return Err(error);
    }

    let record = match fast_wallet::new_restored_record(
        identity_id.clone(),
        label,
        address,
        input.network,
        "independent-restore".to_owned(),
        restore_height,
        derivation_index,
    )
    .and_then(|record| fast_wallet::insert(&app, record))
    {
        Ok(record) => record,
        Err(error) => {
            let _ = secure_store::delete_fast_wallet_password(&identity_id);
            let _ = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&wallet_id, false);
            remove_temporary_wallet_files(&path);
            return Err(error);
        }
    };
    sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .insert(identity_id, wallet_id.clone());
    schedule_wallet_sync(app.clone(), wallet_id.clone(), record.network.clone());
    Ok(FastWalletOpenResponse {
        wallet_id,
        wallet: record,
    })
}
fn create_hardware_wallet_blocking(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    mut input: CreateHardwareWalletInput,
) -> Result<WalletOperationResponse, String> {
    let account_index = input.account_index.unwrap_or(0);
    let role = input.role.as_deref().unwrap_or("standard");
    let create_fast = input.create_fast.unwrap_or(false);
    if role != "standard" || account_index != 0 {
        return Err("Ledger creation must start from the standard account.".to_owned());
    }
    let native_account_index = if create_fast { 1 } else { account_index };
    let uses_ledger_ble = input
        .device_name
        .as_deref()
        .unwrap_or("Ledger")
        .ends_with(":ble");
    let wallet_name = next_wallet_file_name(app, &input.wallet_name, "ledger")?;
    let wallet_network = input.network.clone();
    let restore_height = input
        .restore_height
        .filter(|height| *height > 1)
        .ok_or_else(|| {
            "Choose a Ledger scan start date before its first transaction.".to_owned()
        })?;
    let path = wallet_path(app, &wallet_name)?;
    let mut password = wallet_password_or_generated(&mut input.password)?;
    // Diagnostic only: no address, path, credential, or key material is ever
    // written. This makes an accidental duplicate Ledger initialization clear
    // in the Tauri development log.
    eprintln!(
        "MONERO_DESKTOP_LEDGER_CREATE start role={role} account={native_account_index} transport={} companionFast={create_fast}",
        input.device_name.as_deref().unwrap_or("Ledger")
    );
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .create_from_device(native_wallet::HardwareWalletCreate {
            path: &path,
            password: &password,
            network: network(&input.network)?,
            device_name: input.device_name.as_deref().unwrap_or("Ledger"),
            restore_height,
            subaddress_lookahead: input.subaddress_lookahead.as_deref().unwrap_or(""),
            account_index: native_account_index,
        });
    let wallet_id = match result {
        Ok(wallet_id) => {
            eprintln!(
                "MONERO_DESKTOP_LEDGER_CREATE success role={role} account={native_account_index} companionFast={create_fast}"
            );
            wallet_id
        }
        Err(error) => {
            eprintln!(
                "MONERO_DESKTOP_LEDGER_CREATE failed role={role} account={native_account_index} error={error}"
            );
            password.zeroize();
            let transport_detail = uses_ledger_ble
                .then(|| state.0.lock().ok()?.ledger_connection_status().ok())
                .flatten()
                .and_then(|status| serde_json::from_str::<serde_json::Value>(&status).ok())
                .and_then(|status| status.get("message")?.as_str().map(str::to_owned))
                .filter(|message| !message.trim().is_empty());
            return Err(match transport_detail {
                Some(detail) => format!("{error}. {detail}"),
                None => error,
            });
        }
    };
    let registration = wallet_registry::hardware_wallet(
        &wallet_name,
        &wallet_network,
        Some(restore_height),
        (account_index != 0).then_some(account_index),
        (role != "standard").then_some(role),
        None,
    );
    let response = finish_wallet_operation_with_password(
        app,
        state,
        sessions,
        wallet_id,
        registration,
        password,
        !input.defer_sync.unwrap_or(false),
    )?;
    if create_fast {
        let fast_wallet_name = format!("{wallet_name}-fast");
        let fast_registration = wallet_registry::hardware_wallet(
            &fast_wallet_name,
            &wallet_network,
            Some(restore_height),
            Some(1),
            Some("fast"),
            Some(&response.wallet.id),
        );
        let fast_registration = wallet_registry::upsert_inactive(app, fast_registration)?;
        sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?
            .insert(fast_registration.id.clone(), response.wallet_id.clone());
        diagnostics::record(
            app,
            "ledger.fast-wallet-created",
            &[("account", "1".to_owned())],
        );
    }
    Ok(response)
}

#[tauri::command]
async fn create_hardware_wallet(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: CreateHardwareWalletInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let background_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Wallet creation can wait for several Ledger confirmations. Recheck
        // authorization after scheduling, then keep all native BLE and wallet
        // work off AppKit's main thread so macOS remains responsive.
        let protection = background_app.state::<AppProtectionState>();
        require_app_unlocked(&protection)?;
        let state = background_app.state::<NativeWalletState>();
        let sessions = background_app.state::<WalletSessionState>();
        create_hardware_wallet_blocking(&background_app, &state, &sessions, input)
    })
    .await
    .map_err(|_| "Ledger wallet creation worker stopped unexpectedly.".to_owned())?
}

/// Creates an explicitly requested, local read-only companion for a Ledger.
/// The Ledger asks for approval before exporting its private view key. That
/// key never crosses the Tauri command boundary: it is immediately encrypted
/// in OS secure storage and used to create a local view-only wallet file.
#[tauri::command]
fn enable_ledger_read_only(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    exports: State<'_, LedgerViewKeyExportState>,
    protection: State<'_, AppProtectionState>,
    input: EnableLedgerReadOnlyInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let source = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == input.source_registration_id)
        .ok_or_else(|| {
            "The selected Ledger wallet is no longer saved on this device.".to_owned()
        })?;
    if source.kind != "hardware" || source.role.as_deref().unwrap_or("standard") != "standard" {
        return Err("Choose a normal Ledger wallet for the local read-only copy.".to_owned());
    }
    if input.source_wallet_id.trim().is_empty() {
        return Err(
            "Open and unlock the Ledger wallet before enabling local read-only sync.".to_owned(),
        );
    }
    let active_native_id = wallet_session_id(&sessions, &source.id)?.ok_or_else(|| {
        "Open and unlock the Ledger wallet first, then approve Export view key on the Ledger."
            .to_owned()
    })?;
    if active_native_id != input.source_wallet_id {
        return Err(
            "The selected Ledger session changed. Open the Ledger wallet again and retry."
                .to_owned(),
        );
    }

    // The companion is an implementation detail of the saved Ledger wallet,
    // not a second wallet the user should have to select.  Reuse it when it
    // already exists (for example after an app restart) instead of asking the
    // Ledger to export the same view key again.
    if let Some(companion) = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| {
            wallet.kind == "view-only"
                && wallet.source_wallet_id.as_deref() == Some(source.id.as_str())
        })
    {
        // Resolve the ID in a separate statement so the session mutex is
        // released before bind_ledger_read_session locks it again.
        let companion_native_id = wallet_session_id(&sessions, &companion.id)?;
        if let Some(wallet_id) = companion_native_id {
            schedule_wallet_sync(app.clone(), wallet_id.clone(), companion.network.clone());
            return bind_ledger_read_session(
                &app,
                &state,
                &sessions,
                &source,
                &companion,
                &wallet_id,
                Some(&active_native_id),
            );
        }

        let path = wallet_path(&app, &companion.wallet_name)?;
        let mut password = secure_store::load_wallet_password_current(&companion.id)?
            .ok_or_else(|| {
                "The protected local Ledger balance cache is unavailable. Remove and reconnect this Ledger wallet."
                    .to_owned()
            })?;
        let wallet_id = lock_native_wallet(&app, &state, "ledger-read-only-open")?.open(
            &path,
            &password,
            network(&companion.network)?,
            companion.restore_height.unwrap_or(0),
        );
        password.zeroize();
        let wallet_id = wallet_id?;
        sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?
            .insert(companion.id.clone(), wallet_id.clone());
        let companion = wallet_registry::upsert_inactive(&app, companion)?;
        schedule_wallet_sync(app.clone(), wallet_id.clone(), companion.network.clone());
        diagnostics::record(&app, "ledger.read-only-session-reused", &[]);
        return bind_ledger_read_session(
            &app,
            &state,
            &sessions,
            &source,
            &companion,
            &wallet_id,
            Some(&active_native_id),
        );
    }

    begin_ledger_view_key_export(&app, &exports, &source.id, "open-ledger-session")?;
    let result = create_ledger_read_only_from_open_source(
        &app,
        &state,
        &sessions,
        &source,
        &active_native_id,
        input.restore_height,
        "open-ledger-session",
    );
    finish_ledger_view_key_export(&exports, &source.id);
    let companion_response = result?;
    bind_ledger_read_session(
        &app,
        &state,
        &sessions,
        &source,
        &companion_response.wallet,
        &companion_response.wallet_id,
        Some(&active_native_id),
    )
}

/// Make the encrypted local companion the read session for every logical
/// Ledger entry. Until the first signed key-image import finishes, the live
/// hardware session is retained under an internal-only key. Afterwards it is
/// closed and the app continues with only the non-spending local view wallet.
fn bind_ledger_read_session(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    source: &wallet_registry::RegisteredWallet,
    companion: &wallet_registry::RegisteredWallet,
    companion_native_id: &str,
    hardware_native_id: Option<&str>,
) -> Result<WalletOperationResponse, String> {
    let preserve_hardware_for_reconciliation = source.ledger_key_images_verified_height.is_none();
    if !preserve_hardware_for_reconciliation {
        if let Some(hardware_native_id) =
            hardware_native_id.filter(|wallet_id| *wallet_id != companion_native_id)
        {
            // Creation deferred synchronization, so this close is local and
            // bounded. A close failure must not throw away the already secured
            // view-only wallet; the stale native handle is made unreachable and
            // will be released when the process exits.
            if let Err(error) = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(hardware_native_id, false)
            {
                diagnostics::record(
                    app,
                    "ledger.hardware-session-close-failed",
                    &[("reason", "native-error".to_owned())],
                );
                eprintln!("MONERO_DESKTOP_LEDGER_READ_SESSION hardware-close-failed error={error}");
            }
        }
    }

    let registry = wallet_registry::list(app)?;
    let mut open_sessions = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?;
    bind_ledger_session_ids(
        &mut open_sessions,
        &registry,
        source,
        companion,
        companion_native_id,
        hardware_native_id,
        preserve_hardware_for_reconciliation,
    );
    drop(open_sessions);

    let source = wallet_registry::upsert(app, source.clone())?;
    diagnostics::record(
        app,
        "ledger.read-session-activated",
        &[
            ("kind", "view-only".to_owned()),
            (
                "ledgerSigningSession",
                if preserve_hardware_for_reconciliation {
                    "preserved-for-key-images"
                } else {
                    "closed"
                }
                .to_owned(),
            ),
        ],
    );
    Ok(WalletOperationResponse {
        wallet_id: companion_native_id.to_owned(),
        wallet: source,
    })
}

fn synchronized_wallet_height(raw: &str) -> Result<u64, String> {
    let snapshot: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "The Ledger wallet snapshot could not be verified.".to_owned())?;
    if snapshot
        .get("synchronized")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err("Wait until the local Ledger viewing wallet is fully synchronized.".to_owned());
    }
    snapshot
        .get("walletHeight")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .ok_or_else(|| "The Ledger wallet height could not be verified.".to_owned())
}

fn ensure_ledger_hardware_session(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    source: &wallet_registry::RegisteredWallet,
    diagnostic_flow: &str,
) -> Result<String, String> {
    let signing_session_key = ledger_hardware_session_key(&source.id);
    if let Some(wallet_id) = wallet_session_id(sessions, &signing_session_key)? {
        let status = lock_native_wallet(app, state, "ledger-hardware-session-validate")?
            .hardware_status(&wallet_id);
        let connected = status
            .as_ref()
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|value| value.get("connected").and_then(serde_json::Value::as_bool))
            == Some(true);
        if connected {
            return Ok(wallet_id);
        }
        let reconnect = if status
            .as_ref()
            .err()
            .is_some_and(|error| native_wallet::is_session_stale(error))
        {
            Err(native_wallet::SESSION_STALE_CODE.to_owned())
        } else {
            lock_native_wallet(app, state, "ledger-hardware-session-reconnect-existing")?
                .reconnect_hardware(&wallet_id)
                .map(|_| ())
        };
        match reconnect {
            Ok(()) => return Ok(wallet_id),
            Err(error) if native_wallet::is_session_stale(&error) => {
                let mut open_sessions = sessions
                    .0
                    .lock()
                    .map_err(|_| "Wallet session state is busy.".to_owned())?;
                if open_sessions.get(&signing_session_key) == Some(&wallet_id) {
                    open_sessions.remove(&signing_session_key);
                }
            }
            Err(error) => {
                return Err(format!(
                    "Connect and unlock the Ledger, then open the Monero app on it. {error}"
                ));
            }
        }
    }

    diagnostics::record(
        app,
        "ledger.hardware-session-reopen-started",
        &[("flow", diagnostic_flow.to_owned())],
    );
    let path = wallet_path(app, &source.wallet_name)?;
    let mut password = secure_store::load_wallet_password_current(&source.id)?.ok_or_else(|| {
        "This Ledger wallet's protected local credential is unavailable. Remove and add this Ledger wallet again."
            .to_owned()
    })?;
    let opened = lock_native_wallet(app, state, "ledger-hardware-session-open")?.open(
        &path,
        &password,
        network(&source.network)?,
        source.restore_height.unwrap_or(0),
    );
    password.zeroize();
    let wallet_id = opened?;
    let reconnect = lock_native_wallet(app, state, "ledger-hardware-session-reconnect")?
        .reconnect_hardware(&wallet_id);
    if let Err(error) = reconnect {
        let _ = lock_native_wallet(app, state, "ledger-hardware-session-reconnect-cleanup")?
            .close(&wallet_id, false);
        diagnostics::record(
            app,
            "ledger.hardware-session-reopen-failed",
            &[("flow", diagnostic_flow.to_owned())],
        );
        return Err(format!(
            "Connect and unlock the Ledger, then open the Monero app on it. {error}"
        ));
    }

    let existing = {
        let mut open_sessions = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        if let Some(existing) = open_sessions.get(&signing_session_key).cloned() {
            Some(existing)
        } else {
            open_sessions.insert(signing_session_key, wallet_id.clone());
            None
        }
    };
    if let Some(existing) = existing {
        // A concurrent recovery won the race. Never expose or retain a second
        // hardware handle for the same logical Ledger wallet.
        let _ = lock_native_wallet(app, state, "ledger-hardware-session-race-cleanup")?
            .close(&wallet_id, false);
        return Ok(existing);
    }
    diagnostics::record(
        app,
        "ledger.hardware-session-reopen-complete",
        &[("flow", diagnostic_flow.to_owned())],
    );
    Ok(wallet_id)
}

/// Completes the durable read-only companion after its local scan. The common
/// C++ core asks Ledger only for key images belonging to outputs already found
/// by the companion, then queries spent state once. The hardware wallet never
/// needs to repeat the historical blockchain scan.
#[tauri::command]
fn reconcile_ledger_balance(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: ReconcileLedgerBalanceInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let registry = wallet_registry::list(&app)?;
    let mut source = registry
        .wallets
        .iter()
        .find(|wallet| wallet.id == input.source_registration_id)
        .cloned()
        .ok_or_else(|| "The selected Ledger wallet is no longer saved.".to_owned())?;
    if source.kind != "hardware" || source.role.as_deref().unwrap_or("standard") != "standard" {
        return Err("Choose the normal Ledger wallet to verify its balance.".to_owned());
    }
    let mut companion = registry
        .wallets
        .iter()
        .find(|wallet| {
            wallet.kind == "view-only"
                && wallet.source_wallet_id.as_deref() == Some(source.id.as_str())
        })
        .cloned()
        .ok_or_else(|| "Create the local Ledger read-only copy first.".to_owned())?;
    let view_only_wallet_id = {
        let sessions = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        sessions.get(&companion.id).cloned().ok_or_else(|| {
            "Open the local Ledger read-only copy before verifying its balance.".to_owned()
        })?
    };
    // The in-memory signing handle intentionally disappears when the process
    // exits. If the first key-image import was interrupted, recreate only the
    // hardware session from the encrypted wallet file and ask the already
    // connected Ledger to authorize it. The historical scan remains in the
    // local view-only companion and is never repeated on the hardware device.
    let hardware_wallet_id = ensure_ledger_hardware_session(
        &app,
        &state,
        &sessions,
        &source,
        "key-image-reconciliation",
    )?;
    if hardware_wallet_id == view_only_wallet_id {
        return Err("Ledger signing and read-only sessions must be separate.".to_owned());
    }

    diagnostics::record(&app, "ledger.key-images-started", &[]);
    let native = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?;
    let view_height = synchronized_wallet_height(&native.snapshot(&view_only_wallet_id)?)?;
    let result = native.sync_ledger_key_images(&hardware_wallet_id, &view_only_wallet_id)?;
    drop(native);

    companion.ledger_key_images_verified_at = Some(now());
    companion.ledger_key_images_verified_height = Some(view_height);
    source.ledger_key_images_verified_at = companion.ledger_key_images_verified_at;
    source.ledger_key_images_verified_height = Some(view_height);
    wallet_registry::upsert_inactive(&app, source.clone())?;
    wallet_registry::upsert_inactive(&app, companion.clone())?;
    // Key images are now durable in the encrypted companion. The physical
    // Ledger session is no longer needed for viewing and can be closed without
    // affecting balance reads or future background scans.
    bind_ledger_read_session(
        &app,
        &state,
        &sessions,
        &source,
        &companion,
        &view_only_wallet_id,
        Some(&hardware_wallet_id),
    )?;
    diagnostics::record(
        &app,
        "ledger.key-images-complete",
        &[
            ("walletHeight", view_height.to_string()),
            ("flow", "owned-outputs-only".to_owned()),
        ],
    );
    Ok(result)
}

/// Uses an already-open hardware session only long enough to request the
/// explicit Ledger view-key export. The value is never returned to React.
fn ledger_read_only_exists(app: &AppHandle, source_registration_id: &str) -> Result<bool, String> {
    Ok(wallet_registry::list(app)?.wallets.iter().any(|wallet| {
        wallet.kind == "view-only"
            && wallet.source_wallet_id.as_deref() == Some(source_registration_id)
    }))
}

fn begin_ledger_view_key_export(
    app: &AppHandle,
    exports: &LedgerViewKeyExportState,
    source_registration_id: &str,
    flow: &str,
) -> Result<(), String> {
    let mut in_flight = exports
        .0
        .lock()
        .map_err(|_| "Ledger view-key export state is busy.".to_owned())?;
    if !in_flight.insert(source_registration_id.to_owned()) {
        diagnostics::record(
            app,
            "ledger.view-key-export-duplicate-blocked",
            &[("flow", flow.to_owned())],
        );
        return Err("A Ledger view-key approval is already in progress. Approve or reject the request on the Ledger before trying again.".to_owned());
    }
    diagnostics::record(
        app,
        "ledger.view-key-export-flow-started",
        &[("flow", flow.to_owned())],
    );
    Ok(())
}

fn finish_ledger_view_key_export(exports: &LedgerViewKeyExportState, source_registration_id: &str) {
    if let Ok(mut in_flight) = exports.0.lock() {
        in_flight.remove(source_registration_id);
    }
}

fn create_ledger_read_only_from_open_source(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    source: &wallet_registry::RegisteredWallet,
    source_native_id: &str,
    requested_restore_height: Option<u64>,
    export_flow: &str,
) -> Result<WalletOperationResponse, String> {
    if ledger_read_only_exists(app, &source.id)? {
        return Err(
            "This Ledger already has a local read-only copy. Open it from your wallet list."
                .to_owned(),
        );
    }

    // One command must result in exactly one Core export request.  The
    // structured events make a physical Ledger test diagnosable even when the
    // packaged app has no terminal attached.  They intentionally contain no
    // wallet ID, address, path, password, or key material.
    diagnostics::record(
        app,
        "ledger.view-key-export-requested",
        &[("flow", export_flow.to_owned())],
    );
    eprintln!("MONERO_DESKTOP_LEDGER_READ_ONLY export-requested flow={export_flow}");
    let mut exported_json = match state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .export_hardware_private_view_key(source_native_id)
    {
        Ok(value) => {
            diagnostics::record(
                app,
                "ledger.view-key-export-received",
                &[("flow", export_flow.to_owned())],
            );
            value
        }
        Err(error) => {
            diagnostics::record(
                app,
                "ledger.view-key-export-failed",
                &[
                    ("flow", export_flow.to_owned()),
                    ("stage", "core".to_owned()),
                ],
            );
            return Err(error);
        }
    };
    let mut exported: NativeHardwareViewKeyExport = serde_json::from_str(&exported_json)
        .map_err(|_| "The Ledger returned an invalid view-key response.".to_owned())?;
    exported_json.zeroize();
    if exported.network != source.network
        || exported.address.trim().is_empty()
        || exported.private_view_key.trim().is_empty()
    {
        exported.private_view_key.zeroize();
        diagnostics::record(
            app,
            "ledger.view-key-export-failed",
            &[
                ("flow", export_flow.to_owned()),
                ("stage", "verification".to_owned()),
            ],
        );
        return Err("The Ledger view key could not be verified for this wallet.".to_owned());
    }

    let wallet_name = next_wallet_file_name(app, "", "ledger-read")?;
    let path = wallet_path(app, &wallet_name)?;
    let restore_height = requested_restore_height
        .filter(|height| *height > 0)
        .or(source.restore_height);
    let mut requested_password = String::new();
    let mut local_password = wallet_password_or_generated(&mut requested_password)?;
    let native_wallet_id = match state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .create_view_only(native_wallet::ViewOnlyWalletCreate {
            path: &path,
            password: &local_password,
            network: network(&source.network)?,
            restore_height: restore_height.unwrap_or(0),
            address: &exported.address,
            private_view_key: &exported.private_view_key,
        }) {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            exported.private_view_key.zeroize();
            local_password.zeroize();
            diagnostics::record(
                app,
                "ledger.view-key-export-failed",
                &[
                    ("flow", export_flow.to_owned()),
                    ("stage", "read-only-create".to_owned()),
                ],
            );
            return Err(error);
        }
    };
    if let Err(error) = secure_store::store_ledger_private_view_key(
        &source.id,
        std::mem::take(&mut exported.private_view_key),
    ) {
        let _ = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .close(&native_wallet_id, false);
        local_password.zeroize();
        diagnostics::record(
            app,
            "ledger.view-key-export-failed",
            &[
                ("flow", export_flow.to_owned()),
                ("stage", "secure-store-write".to_owned()),
            ],
        );
        return Err(error);
    }
    // Confirm that the OS credential backend accepted the value while it is
    // still part of this explicit setup operation. Never expose or log it.
    let mut verified_view_key = match secure_store::load_ledger_private_view_key(&source.id) {
        Ok(Some(value)) if !value.trim().is_empty() => value,
        Ok(_) => {
            let _ = secure_store::delete_ledger_private_view_key(&source.id);
            let _ = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&native_wallet_id, false);
            local_password.zeroize();
            diagnostics::record(
                app,
                "ledger.view-key-export-failed",
                &[
                    ("flow", export_flow.to_owned()),
                    ("stage", "secure-store-verify".to_owned()),
                ],
            );
            return Err(
                "The Ledger private view key could not be verified in secure storage.".to_owned(),
            );
        }
        Err(error) => {
            let _ = secure_store::delete_ledger_private_view_key(&source.id);
            let _ = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&native_wallet_id, false);
            local_password.zeroize();
            diagnostics::record(
                app,
                "ledger.view-key-export-failed",
                &[
                    ("flow", export_flow.to_owned()),
                    ("stage", "secure-store-verify".to_owned()),
                ],
            );
            return Err(error);
        }
    };
    verified_view_key.zeroize();
    let registration = wallet_registry::ledger_read_only_wallet(
        &wallet_name,
        &source.network,
        restore_height,
        &source.id,
    );
    match finish_internal_wallet_operation_with_password(
        app,
        state,
        sessions,
        native_wallet_id,
        registration,
        local_password,
        true,
    ) {
        Ok(response) => {
            diagnostics::record(
                app,
                "ledger.view-key-export-complete",
                &[("flow", export_flow.to_owned())],
            );
            eprintln!("MONERO_DESKTOP_LEDGER_READ_ONLY created flow={export_flow}");
            Ok(response)
        }
        Err(error) => {
            let _ = secure_store::delete_ledger_private_view_key(&source.id);
            diagnostics::record(
                app,
                "ledger.view-key-export-failed",
                &[
                    ("flow", export_flow.to_owned()),
                    ("stage", "registration".to_owned()),
                ],
            );
            Err(error)
        }
    }
}

/// Repairs a historic Ledger registration that no longer has its former local
/// file credential. It never tries to recover or replace the Ledger spend key:
/// a short-lived hardware session requests only the user-approved private view
/// key, then creates the durable local read-only companion.
#[tauri::command]
fn create_ledger_read_only_from_device(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    exports: State<'_, LedgerViewKeyExportState>,
    protection: State<'_, AppProtectionState>,
    input: CreateLedgerReadOnlyFromDeviceInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let source = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == input.source_registration_id)
        .ok_or_else(|| {
            "The selected Ledger wallet is no longer saved on this device.".to_owned()
        })?;
    if source.kind != "hardware" || source.role.as_deref().unwrap_or("standard") != "standard" {
        return Err("Choose a normal Ledger wallet for the local read-only copy.".to_owned());
    }
    // Do this before starting a disposable hardware session. Otherwise a
    // second click after a successful export would still wake the Ledger and
    // can look like another private-view-key approval to the owner.
    if ledger_read_only_exists(&app, &source.id)? {
        return Err(
            "This Ledger already has a local read-only copy. Open it from your wallet list."
                .to_owned(),
        );
    }
    begin_ledger_view_key_export(&app, &exports, &source.id, "recovery-device-session")?;

    // This disposable native session exists solely to ask the connected Ledger
    // for its view key. Its random local-file credential is never stored.
    let export_wallet_name = format!("ledger-view-export-{}", now());
    let export_path = wallet_path(&app, &export_wallet_name)?;
    let mut requested_password = String::new();
    let mut export_password = wallet_password_or_generated(&mut requested_password)?;
    let export_wallet_id = match state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .create_from_device(native_wallet::HardwareWalletCreate {
            path: &export_path,
            password: &export_password,
            network: network(&source.network)?,
            device_name: "Ledger",
            restore_height: 0,
            subaddress_lookahead: "",
            account_index: source.account_index.unwrap_or(0),
        }) {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            export_password.zeroize();
            finish_ledger_view_key_export(&exports, &source.id);
            diagnostics::record(
                &app,
                "ledger.recovery-session-failed",
                &[("stage", "device-open".to_owned())],
            );
            return Err(format!(
                "Could not open the connected Ledger for view-key export. Confirm that it is unlocked and the Monero app is open. {error}"
            ));
        }
    };
    diagnostics::record(&app, "ledger.recovery-session-opened", &[]);

    // create_from_device already established this short-lived session and
    // obtained the user-approved view key. Reconnecting here would prompt the
    // Ledger a second time without adding any safety or capability.
    let result = create_ledger_read_only_from_open_source(
        &app,
        &state,
        &sessions,
        &source,
        &export_wallet_id,
        input.restore_height,
        "recovery-device-session",
    );
    let _ = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .close(&export_wallet_id, false);
    remove_temporary_wallet_files(&export_path);
    export_password.zeroize();
    finish_ledger_view_key_export(&exports, &source.id);
    result
}
#[tauri::command]
fn wallet_open_requires_password(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: WalletOpenCredentialInput,
) -> Result<bool, String> {
    require_app_unlocked(&protection)?;
    let registration = registration_for_open(
        &app,
        &input.wallet_name,
        &input.network,
        input.restore_height.filter(|height| *height > 0),
    )?;
    // Neither a Ledger wallet nor its explicitly-created local read-only
    // companion has a user-entered wallet password. Their encrypted local
    // files use a generated credential held only in OS secure storage. The
    // Ledger itself authorizes hardware operations; the read-only copy cannot
    // spend at all.
    if registration.kind == "hardware" || registration.kind == "view-only" {
        eprintln!(
            "MONERO_DESKTOP_WALLET_OPEN credential-check kind={} requires-user-password=false",
            registration.kind
        );
        return Ok(false);
    }
    let credential_registration = physical_registration_for_open(&app, &registration)?;
    let available =
        secure_store::load_wallet_password_current(&credential_registration.id)?.is_some();
    diagnostics::record(
        &app,
        "wallet.credential-check",
        &[
            ("kind", registration.kind.clone()),
            ("available", available.to_string()),
        ],
    );
    Ok(!available)
}

#[tauri::command]
async fn open_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    mut input: OpenWalletInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let started = Instant::now();
    let wallet_name = input.wallet_name.clone();
    let wallet_network = input.network.clone();
    let schedule_sync = !input.defer_sync;
    let restore_height = input.restore_height.filter(|height| *height > 0);
    let registration = registration_for_open(&app, &wallet_name, &wallet_network, restore_height)?;
    diagnostics::record(
        &app,
        "wallet.open-started",
        &[
            ("network", wallet_network),
            ("kind", registration.kind.clone()),
        ],
    );
    let physical_registration = physical_registration_for_open(&app, &registration)?;
    // Wallet opening deliberately reads only the current Data Protection
    // Keychain backend.  Older builds stored one credential per wallet in the
    // legacy login-keychain ACL format. Reading those entries displays macOS'
    // password dialog and turns selecting several wallets into several
    // unrelated login prompts. The app-wide biometric lock is the sole user
    // authentication boundary; legacy credentials are never auto-read or
    // retried from this normal opening path.
    // Reuse in both directions. The Fast account may be selected before the
    // standard account, so checking only the source registration ID would
    // still open and scan the same Ledger file twice in that order.
    let current_registry = wallet_registry::list(&app)?;
    let existing_session_id = {
        let open_sessions = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        shared_native_session_for_physical_registration(
            &current_registry,
            &open_sessions,
            &physical_registration.id,
        )
    };
    if let Some(existing_session_id) = existing_session_id {
        sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?
            .insert(registration.id.clone(), existing_session_id.clone());
        let wallet = wallet_registry::upsert(&app, registration)?;
        if schedule_sync {
            schedule_wallet_sync(
                app.clone(),
                existing_session_id.clone(),
                wallet.network.clone(),
            );
        }
        diagnostics::record(
            &app,
            "wallet.shared-container-session-reused",
            &[("account", wallet.account_index.unwrap_or(0).to_string())],
        );
        return Ok(WalletOperationResponse {
            wallet_id: existing_session_id,
            wallet,
        });
    }
    let path = wallet_path(&app, &physical_registration.wallet_name)?;
    // Wallet file credentials are generated by this app and live only in the
    // platform secure store. The renderer must never supply or retain an
    // individual wallet password after setup; discard any stale legacy field
    // rather than turning it into a second unlock boundary.
    let mut supplied_password = std::mem::take(&mut input.password);
    supplied_password.zeroize();
    let mut password;
    let is_hardware = physical_registration.kind == "hardware";
    let uses_device_credential =
        physical_registration.kind == "hardware" || physical_registration.kind == "view-only";
    if uses_device_credential {
        // This is deliberately not a user password prompt.  Hardware wallet
        // files are assigned a random local credential at creation and only
        // the OS secure store may retrieve it.  The following Ledger
        // reconnect supplies the actual user authorization.
        password = secure_store::load_wallet_password_current(&physical_registration.id)?.ok_or_else(|| {
            if is_hardware {
                "This Ledger wallet's protected local credential is unavailable on this device. Reconnect the Ledger and add this Ledger wallet again; no Ledger PIN or wallet password is required here.".to_owned()
            } else {
                "This local Ledger read-only copy is missing its protected device credential. Remove it and create the read-only copy again from the Ledger; no wallet password is required here.".to_owned()
            }
        })?;
        eprintln!(
            "MONERO_DESKTOP_WALLET_OPEN using-device-held-file-credential kind={}",
            registration.kind
        );
    } else {
        password = secure_store::load_wallet_password_current(&physical_registration.id)?.ok_or_else(|| {
            "This wallet's device-protected unlock data is unavailable on this device. A wallet password will not fix this; restore the wallet from its recovery seed to create a new protected local copy.".to_owned()
        })?;
    }
    let native = lock_native_wallet(&app, &state, "wallet-open")?;
    // The post-unlock warmer and an immediate user selection can race. Recheck
    // while holding the same native engine lock used by the warmer; this makes
    // duplicate Core sessions impossible without delaying the renderer.
    let warm_session_id = {
        let open_sessions = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        shared_native_session_for_physical_registration(
            &current_registry,
            &open_sessions,
            &physical_registration.id,
        )
    };
    if let Some(warm_session_id) = warm_session_id {
        sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?
            .insert(registration.id.clone(), warm_session_id.clone());
        drop(native);
        password.zeroize();
        let wallet = wallet_registry::upsert(&app, registration)?;
        if schedule_sync {
            schedule_wallet_sync(app.clone(), warm_session_id.clone(), wallet.network.clone());
        }
        diagnostics::record(
            &app,
            "wallet.warm-session-activated",
            &[("elapsedMs", started.elapsed().as_millis().to_string())],
        );
        return Ok(WalletOperationResponse {
            wallet_id: warm_session_id,
            wallet,
        });
    }
    let result = native.open(
        &path,
        &password,
        network(&input.network)?,
        input.restore_height.unwrap_or(0),
    );
    drop(native);
    let wallet_id = match result {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            password.zeroize();
            diagnostics::record(
                &app,
                "wallet.open-failed",
                &[
                    ("stage", "native-core".to_owned()),
                    ("elapsedMs", started.elapsed().as_millis().to_string()),
                ],
            );
            return Err(error);
        }
    };
    diagnostics::record(
        &app,
        "wallet.core-opened",
        &[("elapsedMs", started.elapsed().as_millis().to_string())],
    );
    if is_hardware {
        let reconnect = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .reconnect_hardware(&wallet_id);
        if let Err(error) = reconnect {
            let _ = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&wallet_id, false);
            password.zeroize();
            eprintln!("MONERO_DESKTOP_LEDGER_OPEN reconnect-failed error={error}");
            return Err(format!(
                "Connect and unlock the Ledger, then open the Monero app on it. {error}"
            ));
        }
        eprintln!("MONERO_DESKTOP_LEDGER_OPEN reconnect-success");
    }
    // A wallet first opened from an older local file provides its password
    // explicitly. Store that credential only in macOS Keychain so every later
    // unlock uses the same secure, device-held path as newly created wallets.
    let result = finish_wallet_operation_with_password(
        &app,
        &state,
        &sessions,
        wallet_id,
        registration,
        password,
        schedule_sync,
    );
    diagnostics::record(
        &app,
        if result.is_ok() {
            "wallet.open-complete"
        } else {
            "wallet.open-failed"
        },
        &[
            (
                "stage",
                if result.is_ok() {
                    "complete".to_owned()
                } else {
                    "registration-or-sync".to_owned()
                },
            ),
            ("elapsedMs", started.elapsed().as_millis().to_string()),
        ],
    );
    result
}
#[tauri::command]
fn close_wallet(
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .close(&input.wallet_id, true)?;
    sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .retain(|_, session_id| session_id != &input.wallet_id);
    Ok(())
}
#[tauri::command]
fn rename_wallet(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: RenameWalletInput,
) -> Result<wallet_registry::RegisteredWallet, String> {
    require_app_unlocked(&protection)?;
    wallet_registry::rename_wallet(&app, &input.wallet_id, &input.display_name)
}
#[tauri::command]
fn remove_registered_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: RemoveRegisteredWalletInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    // Remove any live native session before hiding its registration. This
    // mirrors mobile's "remove from app" behavior while deliberately keeping
    // the encrypted wallet file and Ledger/seed intact.
    let registry = wallet_registry::list(&app)?;
    let removed_ids = registry
        .wallets
        .iter()
        .filter(|wallet| {
            wallet.id == input.wallet_id
                || wallet.source_wallet_id.as_deref() == Some(input.wallet_id.as_str())
        })
        .map(|wallet| wallet.id.clone())
        .collect::<Vec<_>>();
    if removed_ids.is_empty() {
        return Err("Saved wallet was not found.".to_owned());
    }
    let mut native_close_failures = 0_u8;
    if let Some(signing_session_id) = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .remove(&ledger_hardware_session_key(&input.wallet_id))
    {
        match state.0.try_lock() {
            Ok(native) => {
                if native.close(&signing_session_id, false).is_err() {
                    native_close_failures = native_close_failures.saturating_add(1);
                }
            }
            Err(_) => {
                native_close_failures = native_close_failures.saturating_add(1);
                diagnostics::record(&app, "wallet.remove-ledger-signing-close-deferred", &[]);
            }
        }
    }
    for removed_id in &removed_ids {
        let session_id = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?
            .remove(removed_id);
        if let Some(session_id) = session_id {
            let shared_session_remains = sessions
                .0
                .lock()
                .map_err(|_| "Wallet session state is busy.".to_owned())?
                .values()
                .any(|native_id| native_id == &session_id);
            if shared_session_remains {
                diagnostics::record(&app, "wallet.remove-shared-container-retained", &[]);
                continue;
            }
            // Removing a local registration is intentionally immediate. A
            // background node handshake may own the Core for many seconds;
            // waiting for it here would freeze the confirmation dialog even
            // though the user only asked to hide this local entry. The live
            // session becomes unreachable immediately and is cleaned up on
            // the next lock or process exit.
            let close_result = match state.0.try_lock() {
                Ok(native) => native.close(&session_id, false),
                Err(TryLockError::WouldBlock) => {
                    diagnostics::record(&app, "wallet.remove-native-close-deferred", &[]);
                    Err("Native Core is synchronizing in the background.".to_owned())
                }
                Err(TryLockError::Poisoned(_)) => Err("Native wallet is busy.".to_owned()),
            };
            if let Err(error) = close_result {
                // `WalletEngine::close()` removes the native session from its
                // registry before it persists the cache. A later cache-store
                // failure must therefore not make an obsolete local entry
                // impossible to remove from the UI. The encrypted wallet file
                // and recovery material remain untouched either way.
                native_close_failures = native_close_failures.saturating_add(1);
                eprintln!(
                    "MONERO_DESKTOP_WALLET_REMOVE native-close-failed registration-removal-continues error={error}"
                );
            }
        }
    }
    for removed_id in &removed_ids {
        let _ = secure_store::delete_wallet_password(removed_id);
    }
    let removed_view_only_source_ids = registry
        .wallets
        .iter()
        .filter(|wallet| {
            wallet.id == input.wallet_id
                || wallet.source_wallet_id.as_deref() == Some(input.wallet_id.as_str())
        })
        .filter_map(|wallet| {
            (wallet.kind == "view-only")
                .then(|| wallet.source_wallet_id.clone())
                .flatten()
        })
        .collect::<Vec<_>>();
    for source_id in removed_view_only_source_ids {
        let _ = secure_store::delete_ledger_private_view_key(&source_id);
    }
    if registry
        .wallets
        .iter()
        .any(|wallet| wallet.id == input.wallet_id && wallet.kind == "hardware")
    {
        let _ = secure_store::delete_ledger_private_view_key(&input.wallet_id);
    }
    wallet_registry::remove(&app, &input.wallet_id)?;
    eprintln!(
        "MONERO_DESKTOP_WALLET_REMOVE complete registrations={} native_close_failures={native_close_failures}",
        removed_ids.len()
    );
    Ok(())
}
#[tauri::command]
fn list_registered_wallets(
    app: AppHandle,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<RegisteredWalletView>, String> {
    require_app_unlocked(&protection)?;
    let registry = wallet_registry::list(&app)?;
    let active_wallet_id = registry.active_wallet_id.clone();
    let sessions = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?;
    Ok(registry
        .wallets
        .into_iter()
        .map(|wallet| RegisteredWalletView {
            is_open: sessions.contains_key(&wallet.id),
            is_active: active_wallet_id.as_ref() == Some(&wallet.id),
            wallet,
        })
        .collect())
}
#[tauri::command]
fn activate_registered_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    wallet_id: String,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let registered = wallet_registry::list(&app)?;
    let wallet = registered
        .wallets
        .iter()
        .find(|wallet| wallet.id == wallet_id)
        .cloned()
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    let physical = physical_registration_for_open(&app, &wallet)?;
    let session_id = {
        let open_sessions = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        open_sessions.get(&wallet.id).cloned().or_else(|| {
            shared_native_session_for_physical_registration(
                &registered,
                &open_sessions,
                &physical.id,
            )
        })
    }
    .ok_or_else(|| "This wallet is not open yet.".to_owned())?;
    sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .insert(wallet.id.clone(), session_id.clone());
    let wallet = wallet_registry::upsert(&app, wallet)?;
    try_lock_native_wallet(&app, &state, "wallet-priority")?
        .prioritize_network_wallet(&session_id)?;
    Ok(WalletOperationResponse {
        wallet_id: session_id,
        wallet,
    })
}

fn current_recovered_session(
    app: &AppHandle,
    registration_id: &str,
    generation: u64,
    reopen_attempt: u64,
    reopened: bool,
) -> Result<WalletSessionRecoveryResponse, String> {
    let wallet = wallet_registry::list(app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == registration_id)
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    let sessions = app.state::<WalletSessionState>();
    let wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(registration_id)
        .cloned()
        .ok_or_else(|| native_wallet::SESSION_STALE_CODE.to_owned())?;
    Ok(WalletSessionRecoveryResponse {
        wallet_id,
        wallet,
        session_generation: generation,
        reopen_attempt,
        reopened,
    })
}

fn recovery_sync_context(app: &AppHandle, wallet_network: &str) -> (String, String) {
    let Ok(network_code) = network(wallet_network) else {
        return ("unknown".to_owned(), "0".to_owned());
    };
    let state = app.state::<NativeWalletState>();
    let Ok(native) = state.0.try_lock() else {
        return ("native-busy".to_owned(), "0".to_owned());
    };
    let Ok(raw) = native.network_sync_status(network_code) else {
        return ("unavailable".to_owned(), "0".to_owned());
    };
    let Ok(status) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return ("invalid".to_owned(), "0".to_owned());
    };
    let phase = status
        .get("phase")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let generation = status
        .get("providerGeneration")
        .and_then(|value| {
            value
                .as_u64()
                .map(|number| number.to_string())
                .or_else(|| value.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "0".to_owned());
    (phase, generation)
}

fn reopen_registered_wallet_session(
    app: &AppHandle,
    registration_id: &str,
    diagnostic_digest: &str,
    reopen_attempt: u64,
) -> Result<(String, wallet_registry::RegisteredWallet, usize), String> {
    let registry = wallet_registry::list(app)?;
    let registration = registry
        .wallets
        .iter()
        .find(|wallet| wallet.id == registration_id)
        .cloned()
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    let physical = physical_registration_for_open(app, &registration)?;
    let sessions = app.state::<WalletSessionState>();

    // Remove every logical owner of the obsolete handle in one map mutation.
    // A Ledger parent, Fast account and read-only companion may all lease the
    // same physical session; retaining even one alias recreates the bug.
    let (stale_native_id, owner_count) = {
        let mut open_sessions = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        let stale_native_id = open_sessions.get(registration_id).cloned().or_else(|| {
            shared_native_session_for_physical_registration(&registry, &open_sessions, &physical.id)
        });
        let owner_count = stale_native_id
            .as_ref()
            .map(|native_id| {
                open_sessions
                    .values()
                    .filter(|candidate| *candidate == native_id)
                    .count()
            })
            .unwrap_or(0);
        if let Some(native_id) = stale_native_id.as_ref() {
            open_sessions.retain(|_, candidate| candidate != native_id);
        }
        (stale_native_id, owner_count)
    };
    if let Some(stale_native_id) = stale_native_id.as_ref() {
        if let Ok(mut scheduled) = app.state::<WalletSyncState>().0.lock() {
            scheduled.remove(stale_native_id);
        }
    }
    diagnostics::record(
        app,
        "wallet.session-invalidated",
        &[
            ("registrationDigest", diagnostic_digest.to_owned()),
            ("ownerCount", owner_count.to_string()),
            ("leaseState", "invalidated".to_owned()),
            (
                "safeErrorCode",
                native_wallet::SESSION_STALE_CODE.to_owned(),
            ),
            ("reopenAttempt", reopen_attempt.to_string()),
        ],
    );

    let path = wallet_path(app, &physical.wallet_name)?;
    let mut password = secure_store::load_wallet_password_current(&physical.id)?
        .ok_or_else(|| {
            "This wallet's protected local unlock data is unavailable. Restore the wallet on this device."
                .to_owned()
        })?;
    let state = app.state::<NativeWalletState>();
    let opened = lock_native_wallet(app, &state, "wallet-session-reopen")?.open(
        &path,
        &password,
        network(&physical.network)?,
        physical.restore_height.unwrap_or(0),
    );
    password.zeroize();
    let native_id = opened?;
    if physical.kind == "hardware" {
        if let Err(error) = lock_native_wallet(app, &state, "wallet-session-reopen-ledger")?
            .reconnect_hardware(&native_id)
        {
            let _ = lock_native_wallet(app, &state, "wallet-session-reopen-cleanup")?
                .close(&native_id, false);
            return Err(error);
        }
    }

    let close_failed_reopen = || {
        let _ = lock_native_wallet(app, &state, "wallet-session-reopen-cleanup")
            .and_then(|native| native.close(&native_id, false));
    };
    let registration_id = registration.id.clone();
    let wallet = match wallet_registry::upsert(app, registration) {
        Ok(wallet) => wallet,
        Err(error) => {
            close_failed_reopen();
            return Err(error);
        }
    };
    let prioritize_result = lock_native_wallet(app, &state, "wallet-session-reopen-priority")
        .and_then(|native| native.prioritize_network_wallet(&native_id));
    if let Err(error) = prioritize_result {
        close_failed_reopen();
        return Err(error);
    }

    // Rebind every registration only after the newly opened native session is
    // known to be usable. A failed reopen must not leave a half-published
    // handle in the owner map where a later poll could mistake it for ready.
    let bind_result = (|| -> Result<(), String> {
        let mut open_sessions = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?;
        for candidate in &registry.wallets {
            if physical_registration_for_open(app, candidate)
                .map(|resolved| resolved.id == physical.id)
                .unwrap_or(false)
            {
                open_sessions.insert(candidate.id.clone(), native_id.clone());
            }
        }
        open_sessions.insert(physical.id.clone(), native_id.clone());
        open_sessions.insert(registration_id, native_id.clone());
        Ok(())
    })();
    if let Err(error) = bind_result {
        close_failed_reopen();
        return Err(error);
    }
    schedule_wallet_sync(app.clone(), native_id.clone(), wallet.network.clone());
    Ok((native_id, wallet, owner_count))
}

/// Repairs a process-local handle without exposing its value in diagnostics.
/// Validation, invalidation and reopen are host-owned; the renderer receives
/// only the already established wallet response plus monotonic generation.
#[tauri::command]
async fn recover_registered_wallet_session(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: RegistrationIdInput,
) -> Result<WalletSessionRecoveryResponse, String> {
    require_app_unlocked(&protection)?;
    let registration_id = input.registration_id;
    tauri::async_runtime::spawn_blocking(move || {
        let protection = app.state::<AppProtectionState>();
        require_app_unlocked(&protection)?;
        let recovery = app.state::<WalletSessionRecoveryState>();
        let registry = wallet_registry::list(&app)?;
        let registration = registry
            .wallets
            .iter()
            .find(|wallet| wallet.id == registration_id)
            .cloned()
            .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
        let physical = physical_registration_for_open(&app, &registration)?;
        let recovery_key = physical.id.clone();
        let diagnostic_digest = recovery.diagnostic_digest(&recovery_key);
        let observed_reopen_attempt = recovery.observed_attempt(&recovery_key)?;

        // A request that reached the host after another caller already
        // repaired the handle observes the valid session and returns it. It
        // must not begin a second sequential reopen.
        if let Some(candidate) =
            wallet_session_id(&app.state::<WalletSessionState>(), &registration_id)?
        {
            match lock_native_wallet(
                &app,
                &app.state::<NativeWalletState>(),
                "wallet-session-validate",
            )?
            .snapshot(&candidate)
            {
                Ok(_) => {
                    let state = recovery
                        .registry
                        .lock()
                        .map_err(|_| "Wallet recovery state is busy.".to_owned())?;
                    let generation = state.generations.get(&recovery_key).copied().unwrap_or(1);
                    let attempt = state
                        .reopen_attempts
                        .get(&recovery_key)
                        .copied()
                        .unwrap_or(0);
                    return current_recovered_session(
                        &app,
                        &registration_id,
                        generation,
                        attempt,
                        false,
                    );
                }
                Err(error) if native_wallet::is_session_stale(&error) => {}
                Err(error) => return Err(error),
            }
        }

        let reopen_attempt =
            match recovery.claim_after_stale(&recovery_key, observed_reopen_attempt)? {
                WalletSessionRecoveryClaim::Completed { attempt, outcome } => {
                    let generation = outcome?;
                    return current_recovered_session(
                        &app,
                        &registration_id,
                        generation,
                        attempt,
                        true,
                    );
                }
                WalletSessionRecoveryClaim::Leader { attempt } => attempt,
            };

        let (started_sync_phase, started_provider_generation) =
            recovery_sync_context(&app, &physical.network);

        diagnostics::record(
            &app,
            "wallet.session-reopen-started",
            &[
                ("registrationDigest", diagnostic_digest.clone()),
                ("reopenAttempt", reopen_attempt.to_string()),
                ("phase", "recovering-session".to_owned()),
                ("syncPhase", started_sync_phase),
                ("providerGeneration", started_provider_generation),
                ("leaseState", "single-flight".to_owned()),
            ],
        );
        let reopened = reopen_registered_wallet_session(
            &app,
            &registration_id,
            &diagnostic_digest,
            reopen_attempt,
        );
        let outcome = match reopened {
            Ok((_native_id, wallet, owner_count)) => {
                let generation = {
                    let mut state = recovery
                        .registry
                        .lock()
                        .map_err(|_| "Wallet recovery state is busy.".to_owned())?;
                    let generation = state
                        .generations
                        .get(&recovery_key)
                        .copied()
                        .unwrap_or(0)
                        .saturating_add(1);
                    state.generations.insert(recovery_key.clone(), generation);
                    generation
                };
                let (sync_phase, provider_generation) =
                    recovery_sync_context(&app, &wallet.network);
                diagnostics::record(
                    &app,
                    "wallet.session-reopen-completed",
                    &[
                        ("registrationDigest", diagnostic_digest.clone()),
                        ("sessionGeneration", generation.to_string()),
                        ("reopenAttempt", reopen_attempt.to_string()),
                        ("ownerCount", owner_count.to_string()),
                        ("syncPhase", sync_phase),
                        ("providerGeneration", provider_generation),
                        ("leaseState", "active".to_owned()),
                        ("result", "success".to_owned()),
                    ],
                );
                Ok((generation, wallet))
            }
            Err(error) => {
                let (sync_phase, provider_generation) =
                    recovery_sync_context(&app, &physical.network);
                diagnostics::record(
                    &app,
                    "wallet.session-reopen-failed",
                    &[
                        ("registrationDigest", diagnostic_digest),
                        ("reopenAttempt", reopen_attempt.to_string()),
                        ("syncPhase", sync_phase),
                        ("providerGeneration", provider_generation),
                        ("leaseState", "invalid".to_owned()),
                        ("safeErrorCode", "reopen-failed".to_owned()),
                        ("result", "failed".to_owned()),
                    ],
                );
                Err(error)
            }
        };
        recovery.finish(
            &recovery_key,
            reopen_attempt,
            outcome
                .as_ref()
                .map(|(generation, _)| *generation)
                .map_err(Clone::clone),
        )?;
        let (generation, wallet) = outcome?;
        let wallet_id = wallet_session_id(&app.state::<WalletSessionState>(), &registration_id)?
            .ok_or_else(|| native_wallet::SESSION_STALE_CODE.to_owned())?;
        Ok(WalletSessionRecoveryResponse {
            wallet_id,
            wallet,
            session_generation: generation,
            reopen_attempt,
            reopened: true,
        })
    })
    .await
    .map_err(|_| "Wallet session recovery worker stopped unexpectedly.".to_owned())?
}

/// Starts synchronization for a pre-opened wallet after it becomes the active
/// wallet. Pre-opening is intentionally local-only so several wallets can be
/// prepared before any daemon handshake takes the global Monero Core lock.
#[tauri::command]
fn queue_registered_wallet_sync(
    app: AppHandle,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    wallet_id: String,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    let wallet = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == wallet_id)
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    let native_wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&wallet.id)
        .cloned()
        .ok_or_else(|| "The selected wallet is not open in this session.".to_owned())?;
    schedule_wallet_sync(app, native_wallet_id, wallet.network);
    Ok(())
}
#[tauri::command]
fn list_fast_wallets(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<fast_wallet::FastWalletRecord>, String> {
    require_app_unlocked(&protection)?;
    let wallets = fast_wallet::list(&app)?;
    schedule_fast_wallet_assignment_renewal(app);
    Ok(wallets)
}

const FAST_WALLET_ASSIGNMENT_RENEWAL_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;

fn schedule_fast_wallet_assignment_renewal(app: AppHandle) {
    let maintenance = app.state::<FastWalletMaintenanceState>();
    let Ok(mut running) = maintenance.0.lock() else {
        return;
    };
    if *running {
        return;
    }
    *running = true;
    drop(running);

    tauri::async_runtime::spawn(async move {
        let result = renew_expiring_fast_wallet_assignments(&app).await;
        if let Err(error) = result {
            diagnostics::record(
                &app,
                "fast-wallet.assignment-maintenance-failed",
                &[("error", error)],
            );
        }
        if let Ok(mut running) = app.state::<FastWalletMaintenanceState>().0.lock() {
            *running = false;
        }
    });
}

async fn renew_expiring_fast_wallet_assignments(app: &AppHandle) -> Result<(), String> {
    let current_time = now();
    let renewal_deadline = current_time
        .checked_add(FAST_WALLET_ASSIGNMENT_RENEWAL_WINDOW_SECONDS)
        .ok_or_else(|| "The Fast Wallet renewal time is invalid.".to_owned())?;
    let records = fast_wallet::list(app)?;
    for mut record in records.into_iter().filter(|record| {
        record.notifications_enabled
            && record
                .assignment_expires_at
                .is_some_and(|expires_at| expires_at <= renewal_deadline)
    }) {
        let result = async {
            let previous = fast_wallet_enrollment::load_assignment(&record.id)?
                .ok_or_else(|| "The local payment-alert assignment is missing.".to_owned())?;
            let worker = fast_wallet_enrollment::worker_for_assignment(
                &record.network,
                &previous,
                current_time,
            )
            .await?;
            let assignment =
                fast_wallet_enrollment::sponsor_assignment(app, &record.id, &worker, current_time)
                    .await?;
            let mut password =
                secure_store::load_fast_wallet_password(&record.id)?.ok_or_else(|| {
                    "The protected Fast Wallet credential is unavailable on this device.".to_owned()
                })?;
            let path = fast_wallet::wallet_path(app, &record.id)?;
            let envelope = {
                let state = app.state::<NativeWalletState>();
                let sealed = state
                    .0
                    .lock()
                    .map_err(|_| "Native wallet is busy.".to_owned())?
                    .seal_fast_receive_watch(
                        &record.id,
                        &path,
                        &password,
                        network(&record.network)?,
                        record.restore_height,
                        &worker.descriptor_hex,
                        &assignment.assignment_handle,
                        assignment.assignment_epoch,
                        current_time,
                        current_time
                            .checked_add(fast_wallet_enrollment::WATCH_LIFETIME_SECONDS)
                            .ok_or_else(|| "The encrypted watch expiry is invalid.".to_owned())?,
                        current_time,
                    );
                password.zeroize();
                sealed?
            };
            let message_id = fast_wallet_enrollment::submit_watch(&worker, &envelope).await?;
            Ok::<_, String>((assignment, message_id))
        }
        .await;

        match result {
            Ok((assignment, message_id)) => {
                record.alert_status = "on".to_owned();
                record.notifications_enabled = true;
                record.assignment_handle = Some(assignment.assignment_handle);
                record.assignment_epoch = Some(assignment.assignment_epoch);
                record.assignment_expires_at = Some(assignment.expires_at);
                record.watch_message_id = Some(message_id);
                fast_wallet::update(app, record.clone())?;
                diagnostics::record(
                    app,
                    "fast-wallet.assignment-renewed",
                    &[
                        ("identityId", record.id),
                        (
                            "assignmentEpoch",
                            record.assignment_epoch.unwrap_or_default().to_string(),
                        ),
                    ],
                );
            }
            Err(error) => {
                let expired = record
                    .assignment_expires_at
                    .is_none_or(|expires_at| expires_at <= current_time);
                if expired {
                    record.alert_status = "needs-attention".to_owned();
                    record.notifications_enabled = false;
                    let _ = fast_wallet::update(app, record.clone());
                }
                diagnostics::record(
                    app,
                    "fast-wallet.assignment-renewal-failed",
                    &[
                        ("identityId", record.id),
                        ("expired", expired.to_string()),
                        ("error", error),
                    ],
                );
            }
        }
    }
    Ok(())
}
#[tauri::command]
fn open_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, FastWalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: FastWalletIdInput,
) -> Result<FastWalletOpenResponse, String> {
    require_app_unlocked(&protection)?;
    let wallet = fast_wallet::get(&app, &input.identity_id)?;
    fast_wallet::require_independent_software(&wallet)?;
    if let Some(wallet_id) = sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .get(&wallet.id)
        .cloned()
    {
        return Ok(FastWalletOpenResponse { wallet_id, wallet });
    }
    let path = fast_wallet::wallet_path(&app, &wallet.id)?;
    let mut password = secure_store::load_fast_wallet_password(&wallet.id)?
        .ok_or_else(|| "The Fast Wallet password is not available in secure storage.".to_owned())?;
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .open(
            &path,
            &password,
            network(&wallet.network)?,
            wallet.restore_height,
        );
    password.zeroize();
    let wallet_id = result?;
    sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .insert(wallet.id.clone(), wallet_id.clone());
    // Opening a Fast Wallet is a local file operation.  Configuring a remote
    // daemon can take seconds, so it follows the same deferred path as a
    // normal wallet rather than holding the button in “Working…”.
    diagnostics::record(
        &app,
        "fast-wallet.sync-queued",
        &[("network", wallet.network.clone())],
    );
    schedule_wallet_sync(app.clone(), wallet_id.clone(), wallet.network.clone());
    Ok(FastWalletOpenResponse { wallet_id, wallet })
}
#[tauri::command]
fn close_fast_wallet(
    state: State<'_, NativeWalletState>,
    sessions: State<'_, FastWalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: FastWalletIdInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    let wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .remove(&input.identity_id)
        .ok_or_else(|| "Fast Wallet is not open in this desktop session.".to_owned())?;
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .close(&wallet_id, true);
    if result.is_err() {
        let _ = sessions
            .0
            .lock()
            .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
            .insert(input.identity_id, wallet_id);
    }
    result
}

fn validate_fast_wallet_removal_snapshot(raw: &str) -> Result<(), String> {
    let snapshot: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "The Fast Wallet balance could not be verified safely.".to_owned())?;
    let synchronized = snapshot
        .get("synchronized")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "The Fast Wallet synchronization state is unknown.".to_owned())?;
    if !synchronized {
        return Err(
            "The Fast Wallet cannot be removed until local synchronization is complete.".to_owned(),
        );
    }
    let balance = snapshot
        .get("balanceAtomic")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The Fast Wallet balance is unknown.".to_owned())?
        .parse::<u128>()
        .map_err(|_| "The Fast Wallet balance is unknown.".to_owned())?;
    if balance != 0 {
        return Err(
            "This Fast Wallet still contains Monero. Send the remaining balance before removing it."
                .to_owned(),
        );
    }
    Ok(())
}

#[tauri::command]
fn remove_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, FastWalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: FastWalletIdInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    let record = fast_wallet::get(&app, &input.identity_id)?;
    fast_wallet::require_independent_software(&record)?;
    diagnostics::record(
        &app,
        "fast-wallet.remove-started",
        &[("seedBackupStatus", record.seed_backup_status.clone())],
    );
    // An empty, fully synchronized Fast Wallet may be discarded even when
    // its recovery words were never confirmed. Requiring a backup made fresh
    // test wallets impossible to remove and did not protect funds: the native
    // snapshot check below is the authoritative zero-balance safety gate.
    if record.assignment_handle.is_some()
        || fast_wallet_enrollment::load_assignment(&record.id)?.is_some()
    {
        diagnostics::record(
            &app,
            "fast-wallet.remove-blocked",
            &[("reason", "hosted-scan-data-present".to_owned())],
        );
        return Err(
            "Delete this Fast Wallet's hosted scan data before removing the local wallet."
                .to_owned(),
        );
    }
    let wallet_id = match sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .get(&record.id)
        .cloned()
    {
        Some(wallet_id) => wallet_id,
        None => {
            diagnostics::record(
                &app,
                "fast-wallet.remove-blocked",
                &[("reason", "wallet-not-open".to_owned())],
            );
            return Err("Open and synchronize this Fast Wallet before removing it.".to_owned());
        }
    };
    let raw = match state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .snapshot(&wallet_id)
    {
        Ok(raw) => raw,
        Err(error) => {
            diagnostics::record(
                &app,
                "fast-wallet.remove-blocked",
                &[
                    ("reason", "snapshot-failed".to_owned()),
                    ("error", error.clone()),
                ],
            );
            return Err(error);
        }
    };
    if let Err(error) = validate_fast_wallet_removal_snapshot(&raw) {
        diagnostics::record(
            &app,
            "fast-wallet.remove-blocked",
            &[
                ("reason", "snapshot-not-removable".to_owned()),
                ("error", error.clone()),
            ],
        );
        return Err(error);
    }
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .close(&wallet_id, true)?;
    sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .remove(&record.id);

    // Durable public metadata is removed before best-effort local cleanup. If
    // cleanup is interrupted, an encrypted zero-balance file may remain, but a
    // funded or unverified wallet is never made unrecoverable.
    fast_wallet::remove(&app, &record.id)?;
    let _ = secure_store::delete_fast_wallet_password(&record.id);
    let path = fast_wallet::wallet_path(&app, &record.id)?;
    remove_temporary_wallet_files(&path);
    diagnostics::record(&app, "fast-wallet.removed", &[]);
    Ok(())
}

/// Remove a Fast Wallet entry that cannot yet pass the permanent-removal
/// safety gate.  This is intentionally a metadata-only action: the encrypted
/// wallet file and its recovery material stay on disk so an unbacked or legacy
/// wallet can never be made unrecoverable by a list-management click.
#[tauri::command]
fn remove_fast_wallet_entry(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, FastWalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: FastWalletIdInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    let record = fast_wallet::get(&app, &input.identity_id)?;
    if record.assignment_handle.is_some()
        || fast_wallet_enrollment::load_assignment(&record.id)?.is_some()
    {
        diagnostics::record(
            &app,
            "fast-wallet.entry-remove-blocked",
            &[("reason", "hosted-scan-data-present".to_owned())],
        );
        return Err(
            "Delete this Fast Wallet's hosted scan data before removing its local entry."
                .to_owned(),
        );
    }
    let wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .get(&record.id)
        .cloned();
    if let Some(wallet_id) = wallet_id.as_ref() {
        state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .close(wallet_id, true)?;
        sessions
            .0
            .lock()
            .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
            .remove(&record.id);
    }
    fast_wallet::remove(&app, &record.id)?;
    diagnostics::record(
        &app,
        "fast-wallet.entry-removed",
        &[
            ("legacy", (record.status == "legacy-blocked").to_string()),
            ("seedBackupStatus", record.seed_backup_status),
            ("filesRetained", "true".to_owned()),
        ],
    );
    Ok(())
}

fn show_native_recovery_seed_backup(wallet_label: &str, seed: &str, fast_wallet: bool) -> bool {
    let numbered_words = Zeroizing::new(
        seed.split_whitespace()
            .enumerate()
            .map(|(index, word)| format!("{}. {}", index + 1, word))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let description = Zeroizing::new(format!(
        "Wallet: {wallet_label}\n\n{}\n\nWrite down every recovery word in order and keep them offline. Never share these words.\n\nChoose Yes only after you have safely saved all words. Choose No to keep the backup pending.",
        numbered_words.as_str(),
    ));
    MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title(if fast_wallet {
            "Back up Fast Wallet recovery words"
        } else {
            "Back up wallet recovery words"
        })
        .set_description(description.as_str())
        .set_buttons(MessageButtons::YesNo)
        .show()
        == MessageDialogResult::Yes
}

#[tauri::command]
async fn present_fast_wallet_recovery_seed(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, FastWalletSessionState>,
    protection: State<'_, AppProtectionState>,
    mut input: PresentRecoverySeedInput,
) -> Result<bool, String> {
    require_app_unlocked(&protection)?;
    diagnostics::record(&app, "wallet.seed-presentation-started", &[]);
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Approve showing the Fast Wallet recovery seed",
    )
    .await?;
    diagnostics::record(&app, "wallet.seed-presentation-authorized", &[]);

    let record = fast_wallet::get(&app, &input.registration_id)?;
    fast_wallet::require_independent_software(&record)?;
    let native_wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .get(&record.id)
        .cloned()
        .ok_or_else(|| "Open this Fast Wallet before backing it up.".to_owned())?;
    if native_wallet_id != input.wallet_id {
        return Err("The recovery-seed request does not match the open Fast Wallet.".to_owned());
    }

    // Recovery words must never cross Tauri IPC or enter renderer memory. Keep
    // the secret in Rust and combine presentation with the user's backup
    // confirmation in one trusted native operation.
    let seed = Zeroizing::new(
        state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .recovery_seed(&native_wallet_id)?,
    );
    let confirmed = show_native_recovery_seed_backup(&record.label, seed.as_str(), true);
    diagnostics::record(
        &app,
        if confirmed {
            "wallet.seed-backup-confirmed"
        } else {
            "wallet.seed-backup-deferred"
        },
        &[
            ("kind", "fast".to_owned()),
            ("boundary", "native".to_owned()),
        ],
    );
    if confirmed {
        fast_wallet::mark_seed_backed_up(&app, &record.id)?;
    }
    Ok(confirmed)
}
#[tauri::command]
fn create_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    mut input: CreateFastWalletInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    require_app_unlocked(&protection)?;
    let source = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == input.source_registration_id)
        .ok_or_else(|| "The source wallet is not saved on this device.".to_owned())?;
    if source.kind != "software" {
        return Err(
            "Open a software wallet before creating an independent Fast Wallet. Ledger Fast Wallet hosting is disabled."
                .to_owned(),
        );
    }
    let source_session_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&source.id)
        .cloned()
        .ok_or_else(|| {
            "Open the source software wallet before creating a Fast Wallet.".to_owned()
        })?;
    if source_session_id != input.source_wallet_id {
        return Err(
            "The selected source wallet is no longer the active unlocked wallet.".to_owned(),
        );
    }

    let derivation_index = fast_wallet::derivation_index(&app)?;
    let identity_id = fast_wallet::identity_id(derivation_index);
    let path = fast_wallet::wallet_path(&app, &identity_id)?;
    let label = if input.label.trim().is_empty() {
        "Fast Wallet".to_owned()
    } else {
        input.label.trim().to_owned()
    };
    let restore_height = input
        .restore_height
        .filter(|height| *height > 1)
        .or(source.restore_height)
        .unwrap_or(0);
    // A software Fast Wallet is a wholly independent random wallet. It also
    // receives its own high-entropy file password so compromise of either
    // secure-store entry does not unlock the other wallet file.
    input.password.zeroize();
    let mut empty_password = String::new();
    let mut fast_password = wallet_password_or_generated(&mut empty_password)?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .create_fast_receive_identity(native_wallet::FastReceiveIdentityCreate {
            source_wallet_id: &source_session_id,
            identity_id: &identity_id,
            path: &path,
            password: &fast_password,
            label: &label,
            restore_height,
            derivation_index,
        });
    let mut raw = match raw {
        Ok(value) => value,
        Err(error) => {
            fast_password.zeroize();
            return Err(error);
        }
    };
    // Retain the credential before parsing public metadata. It never crosses
    // the Tauri boundary and the local identity remains recoverable if a
    // later metadata write is interrupted.
    if let Err(error) =
        secure_store::store_fast_wallet_password(&identity_id, std::mem::take(&mut fast_password))
    {
        let _ = secure_store::delete_fast_wallet_password(&identity_id);
        remove_temporary_wallet_files(&path);
        raw.zeroize();
        return Err(error);
    }
    let parsed = serde_json::from_str::<NativeFastWalletIdentity>(&raw);
    raw.zeroize();
    let record = (|| {
        let identity =
            parsed.map_err(|_| "The native Fast Wallet identity was invalid.".to_owned())?;
        if identity.id != identity_id
            || identity.network != source.network
            || identity.scanner_status != "local-only"
        {
            return Err(
                "The native Fast Wallet identity did not match the selected source wallet."
                    .to_owned(),
            );
        }
        let native_restore_height = identity
            .restore_height
            .parse::<u64>()
            .map_err(|_| "The native Fast Wallet restore height was invalid.".to_owned())?;
        let native_derivation_index = identity
            .derivation_index
            .parse::<u64>()
            .map_err(|_| "The native Fast Wallet derivation index was invalid.".to_owned())?;
        if native_derivation_index != derivation_index {
            return Err("The native Fast Wallet derivation index did not match.".to_owned());
        }
        let record = fast_wallet::new_record(
            identity.id,
            identity.label,
            identity.address,
            identity.network,
            source.id,
            native_restore_height,
            native_derivation_index,
        )?;
        fast_wallet::insert(&app, record)
    })();
    if record.is_err() {
        let _ = secure_store::delete_fast_wallet_password(&identity_id);
        remove_temporary_wallet_files(&path);
    }
    record
}
#[tauri::command]
async fn pair_private_fast_wallet_worker(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: PairPrivateFastWalletWorkerInput,
) -> Result<fast_wallet_enrollment::PairedWorkerView, String> {
    require_app_unlocked(&protection)?;
    let current_time = now();
    let (worker, view) = fast_wallet_enrollment::verify_private_worker_qr(
        &input.worker_qr,
        &input.network,
        current_time,
    )?;
    input.worker_qr.zeroize();
    let roots = fast_wallet_enrollment::paired_private_worker_roots()?;
    if roots.iter().any(|root| root != &view.worker_root_id) {
        let has_assignment = fast_wallet::list(&app)?.iter().try_fold(
            false,
            |found, record| -> Result<bool, String> {
                Ok(found
                    || record.assignment_handle.is_some()
                    || fast_wallet_enrollment::load_assignment(&record.id)?.is_some())
            },
        )?;
        if has_assignment {
            input.app_password.zeroize();
            return Err(
                "Delete hosted scan data for every Fast Wallet before pairing a different private scan service."
                    .to_owned(),
            );
        }
    }
    require_fresh_app_authorization(
        app,
        &mut input.app_password,
        &format!(
            "Trust private scan service {} ({})? It can recognize incoming Fast Wallet payments, but it cannot spend them.",
            view.relay_origin, view.fingerprint
        ),
    )
    .await?;
    fast_wallet_enrollment::store_private_worker(&input.network, &worker)?;
    eprintln!(
        "MONERO_DESKTOP_FAST_WALLET_WORKER selected kind=private network={}",
        input.network
    );
    Ok(view)
}

#[tauri::command]
async fn list_community_fast_wallet_workers(
    protection: State<'_, AppProtectionState>,
    input: ListCommunityFastWalletWorkersInput,
) -> Result<Vec<fast_wallet_enrollment::CommunityWorkerView>, String> {
    require_app_unlocked(&protection)?;
    let workers = fast_wallet_enrollment::community_workers(&input.network, now()).await?;
    eprintln!(
        "MONERO_DESKTOP_FAST_WALLET_WORKER directory-loaded network={} count={}",
        input.network,
        workers.len()
    );
    Ok(workers)
}

#[tauri::command]
async fn select_community_fast_wallet_worker(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: SelectCommunityFastWalletWorkerInput,
) -> Result<fast_wallet_enrollment::PairedWorkerView, String> {
    require_app_unlocked(&protection)?;
    let (worker, view) =
        fast_wallet_enrollment::verify_community_worker(&input.worker, &input.network, now())?;
    let roots = fast_wallet_enrollment::paired_private_worker_roots()?;
    if roots.iter().any(|root| root != &view.worker_root_id) {
        let has_assignment = fast_wallet::list(&app)?.iter().try_fold(
            false,
            |found, record| -> Result<bool, String> {
                Ok(found
                    || record.assignment_handle.is_some()
                    || fast_wallet_enrollment::load_assignment(&record.id)?.is_some())
            },
        )?;
        if has_assignment {
            input.app_password.zeroize();
            return Err(
                "Delete hosted scan data for every Fast Wallet before selecting a different Community Worker."
                    .to_owned(),
            );
        }
    }
    require_fresh_app_authorization(
        app,
        &mut input.app_password,
        &format!(
            "Use approved Community scan service {} ({})? It can recognize incoming Fast Wallet payments, but it cannot spend them.",
            view.relay_origin, view.fingerprint
        ),
    )
    .await?;
    fast_wallet_enrollment::store_private_worker(&input.network, &worker)?;
    eprintln!(
        "MONERO_DESKTOP_FAST_WALLET_WORKER selected kind=community network={}",
        input.network
    );
    Ok(view)
}

#[tauri::command]
async fn enable_encrypted_fast_wallet_alerts(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    mut input: EncryptedFastWalletAlertsInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    require_app_unlocked(&protection)?;
    let enrollment_started = Instant::now();
    diagnostics::record(
        &app,
        "fast-wallet.enrollment-started",
        &[("worker", input.worker.clone())],
    );
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    fast_wallet::require_independent_software(&record)?;
    if record.seed_backup_status != "verified" {
        input.app_password.zeroize();
        return Err("Back up this Fast Wallet before turning payment alerts on.".to_owned());
    }
    let release_gate = match input.worker.as_str() {
        "official" => release_features::require(
            "officialWorker",
            "The recommended payment-alert service is disabled in this signed app.",
        ),
        "private" => release_features::require(
            "privateWorkerPairing",
            "Private scan-service pairing is disabled in this signed app.",
        ),
        _ => Err("Choose the recommended or your paired private scan service.".to_owned()),
    };
    if let Err(error) = release_gate {
        input.app_password.zeroize();
        diagnostics::record(
            &app,
            "fast-wallet.enrollment-failed",
            &[
                ("phase", "release-gate".to_owned()),
                (
                    "elapsedMs",
                    enrollment_started.elapsed().as_millis().to_string(),
                ),
                ("error", error.clone()),
            ],
        );
        return Err(error);
    }
    if let Err(error) = require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Turn on private incoming-payment alerts for this Fast Wallet",
    )
    .await
    {
        diagnostics::record(
            &app,
            "fast-wallet.enrollment-failed",
            &[
                ("phase", "authorization".to_owned()),
                (
                    "elapsedMs",
                    enrollment_started.elapsed().as_millis().to_string(),
                ),
                ("error", error.clone()),
            ],
        );
        return Err(error);
    }

    if let Err(error) = desktop_notifications::request_installation(
        &app,
        desktop_notifications::RequestNotificationInstallationInput {
            permission_status: "authorized".to_owned(),
            locale: None,
            app_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            background_mode_enabled: Some(true),
        },
    ) {
        diagnostics::record(
            &app,
            "fast-wallet.enrollment-failed",
            &[
                ("phase", "notification-installation".to_owned()),
                (
                    "elapsedMs",
                    enrollment_started.elapsed().as_millis().to_string(),
                ),
                ("error", error.clone()),
            ],
        );
        return Err(error);
    }
    let notification_status = match desktop_notifications::reconcile_gateway(&app).await {
        Ok(status) => status,
        Err(error) => {
            diagnostics::record(
                &app,
                "fast-wallet.enrollment-failed",
                &[
                    ("phase", "notification-gateway".to_owned()),
                    (
                        "elapsedMs",
                        enrollment_started.elapsed().as_millis().to_string(),
                    ),
                    ("error", error.clone()),
                ],
            );
            return Err(error);
        }
    };
    if notification_status.installation.gateway_status != "active" {
        let error = "The desktop notification service is still being prepared.".to_owned();
        diagnostics::record(
            &app,
            "fast-wallet.enrollment-failed",
            &[
                ("phase", "notification-gateway".to_owned()),
                (
                    "elapsedMs",
                    enrollment_started.elapsed().as_millis().to_string(),
                ),
                ("error", error.clone()),
            ],
        );
        return Err(error);
    }
    record.alert_status = "setting-up".to_owned();
    record.notifications_enabled = false;
    record = fast_wallet::update(&app, record)?;

    let result = async {
        let current_time = now();
        let worker_result = if input.worker == "official" {
            fast_wallet_enrollment::official_worker(&record.network, current_time).await
        } else {
            fast_wallet_enrollment::load_private_worker(&record.network, current_time)
        };
        let worker = worker_result.map_err(|error| ("worker-descriptor", error))?;
        let assignment =
            fast_wallet_enrollment::sponsor_assignment(&app, &record.id, &worker, current_time)
                .await
                .map_err(|error| ("assignment", error))?;
        let mut password = secure_store::load_fast_wallet_password(&record.id)
            .map_err(|error| ("credential", error))?
            .ok_or_else(|| {
                (
                    "credential",
                    "The protected Fast Wallet credential is unavailable on this device."
                        .to_owned(),
                )
            })?;
        let path =
            fast_wallet::wallet_path(&app, &record.id).map_err(|error| ("credential", error))?;
        let envelope = state
            .0
            .lock()
            .map_err(|_| ("encryption", "Native wallet is busy.".to_owned()))?
            .seal_fast_receive_watch(
                &record.id,
                &path,
                &password,
                network(&record.network).map_err(|error| ("encryption", error))?,
                record.restore_height,
                &worker.descriptor_hex,
                &assignment.assignment_handle,
                assignment.assignment_epoch,
                current_time,
                current_time
                    .checked_add(fast_wallet_enrollment::WATCH_LIFETIME_SECONDS)
                    .ok_or_else(|| {
                        (
                            "encryption",
                            "The encrypted watch expiry is invalid.".to_owned(),
                        )
                    })?,
                current_time,
            );
        password.zeroize();
        let envelope = envelope.map_err(|error| ("encryption", error))?;
        let message_id = fast_wallet_enrollment::submit_watch(&worker, &envelope)
            .await
            .map_err(|error| ("relay-upload", error))?;
        Ok::<_, (&'static str, String)>((assignment, message_id))
    }
    .await;

    match result {
        Ok((assignment, message_id)) => {
            record.alert_status = "on".to_owned();
            record.notifications_enabled = true;
            record.assignment_handle = Some(assignment.assignment_handle);
            record.assignment_epoch = Some(assignment.assignment_epoch);
            record.assignment_expires_at = Some(assignment.expires_at);
            record.watch_message_id = Some(message_id);
            let record = fast_wallet::update(&app, record)?;
            diagnostics::record(
                &app,
                "fast-wallet.enrollment-accepted",
                &[(
                    "elapsedMs",
                    enrollment_started.elapsed().as_millis().to_string(),
                )],
            );
            Ok(record)
        }
        Err((phase, error)) => {
            record.alert_status = "needs-attention".to_owned();
            record.notifications_enabled = false;
            let _ = fast_wallet::update(&app, record);
            diagnostics::record(
                &app,
                "fast-wallet.enrollment-failed",
                &[
                    ("phase", phase.to_owned()),
                    (
                        "elapsedMs",
                        enrollment_started.elapsed().as_millis().to_string(),
                    ),
                    ("error", error.clone()),
                ],
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn turn_off_fast_wallet_alerts(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: AuthorizedAlertsInput,
) -> Result<Vec<fast_wallet::FastWalletRecord>, String> {
    require_app_unlocked(&protection)?;
    if !release_features::enabled("officialWorker")
        && !release_features::enabled("privateWorkerPairing")
    {
        input.app_password.zeroize();
        return Err("Payment alerts are disabled in this signed app.".to_owned());
    }
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Turn off all Fast Wallet payment alerts on this device",
    )
    .await?;
    fast_wallet_enrollment::disable_delivery(&app).await?;
    desktop_notifications::disable_installation(&app)?;
    let mut updated = Vec::new();
    for mut record in fast_wallet::list(&app)? {
        record.notifications_enabled = false;
        record.alert_status = "off".to_owned();
        updated.push(fast_wallet::update(&app, record)?);
    }
    Ok(updated)
}

#[tauri::command]
async fn delete_hosted_fast_wallet_data(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: AuthorizedFastWalletIdInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    require_app_unlocked(&protection)?;
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    fast_wallet::require_independent_software(&record)?;
    let assignment = fast_wallet_enrollment::load_assignment(&record.id)?
        .ok_or_else(|| "This Fast Wallet has no hosted scan data.".to_owned())?;
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Delete this Fast Wallet's hosted scan data",
    )
    .await?;
    fast_wallet_enrollment::delete_assignment(&app, &record.id, &assignment.assignment_handle)
        .await?;
    record.notifications_enabled = false;
    record.alert_status = "off".to_owned();
    record.assignment_handle = None;
    record.assignment_epoch = None;
    record.assignment_expires_at = None;
    record.watch_message_id = None;
    fast_wallet::update(&app, record)
}

#[tauri::command]
async fn enable_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: FastWalletEnableInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "plaintextFastWalletHosting",
        "Legacy scanner hosting is disabled. Use encrypted Worker pairing when it becomes available.",
    )?;
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    fast_wallet::require_independent_software(&record)?;
    let scanner_url = fast_wallet::scanner_url(&input.scanner_url)?;
    let mut password = secure_store::load_fast_wallet_password(&record.id)?
        .ok_or_else(|| "The Fast Wallet password is not available in secure storage. Create a new Fast Wallet identity before enabling the scanner.".to_owned())?;
    let path = fast_wallet::wallet_path(&app, &record.id)?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .fast_receive_registration_payload(
            &record.id,
            &path,
            &password,
            network(&record.network)?,
            record.restore_height,
        );
    password.zeroize();
    let mut raw = raw?;
    let parsed = serde_json::from_str::<NativeFastWalletRegistrationPayload>(&raw);
    raw.zeroize();
    let mut payload =
        parsed.map_err(|_| "The native Fast Wallet scanner payload was invalid.".to_owned())?;
    // The scanner receives only this anonymous installation capability when
    // the user opted into notifications. It is not a push-provider token nor
    // a wallet identifier and lets the Linux background agent retrieve only
    // generic opaque event ids from the notification gateway.
    let subscription_id = notification_subscription_id(&app)?;
    let result = register_fast_wallet_with_scanner(
        &scanner_url,
        &record,
        &mut payload,
        subscription_id.as_deref(),
    )
    .await;
    payload.private_view_key.zeroize();
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            record.status = "registration-error".to_owned();
            record.scanner_status = "registration-error".to_owned();
            record.scanner_url = scanner_url;
            record.scanner_checked_at = Some(now());
            let _ = fast_wallet::update(&app, record);
            return Err(error);
        }
    };
    if let Err(error) = apply_scanner_response(&mut record, &scanner_url, response) {
        let _ = fast_wallet::update(&app, record);
        return Err(error);
    }
    fast_wallet::update(&app, record)
}
/// Registers the reserved Ledger Fast account with a scanner after explicit
/// consent in the renderer. The private view key is requested once from the
/// already-open Ledger session, stays in Rust, and is zeroized immediately
/// after the HTTPS registration call. The Ledger spend key is never read.
#[tauri::command]
async fn enable_ledger_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    exports: State<'_, LedgerViewKeyExportState>,
    protection: State<'_, AppProtectionState>,
    input: LedgerFastWalletEnableInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "ledgerFastWallet",
        "Ledger Fast Wallet is disabled by release configuration.",
    )?;
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    let source = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == record.source_registration_id)
        .ok_or_else(|| "The Ledger Fast Wallet source is not saved on this device.".to_owned())?;
    if source.kind != "hardware" || source.role.as_deref().unwrap_or("standard") != "standard" {
        return Err("This Fast Wallet is not backed by a normal Ledger wallet.".to_owned());
    }
    let source_session_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&source.id)
        .cloned()
        .ok_or_else(|| {
            "Open the normal Ledger wallet first, then approve Export view key once on the Ledger."
                .to_owned()
        })?;
    if source_session_id != input.source_wallet_id {
        return Err(
            "The selected Ledger session changed. Open the normal Ledger wallet again and retry."
                .to_owned(),
        );
    }
    let scanner_url = fast_wallet::scanner_url(&input.scanner_url)?;
    begin_ledger_view_key_export(&app, &exports, &source.id, "ledger-fast-scanner")?;
    diagnostics::record(
        &app,
        "ledger.view-key-export-requested",
        &[("flow", "ledger-fast-scanner".to_owned())],
    );
    let result = async {
        let mut exported_json = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .export_hardware_private_view_key(&source_session_id)?;
        let mut exported: NativeHardwareViewKeyExport = serde_json::from_str(&exported_json)
            .map_err(|_| "The Ledger returned an invalid view-key response.".to_owned())?;
        exported_json.zeroize();
        diagnostics::record(
            &app,
            "ledger.view-key-export-received",
            &[("flow", "ledger-fast-scanner".to_owned())],
        );
        if exported.network != source.network || exported.private_view_key.trim().is_empty() {
            exported.private_view_key.zeroize();
            return Err(
                "The Ledger view key could not be verified for this Fast Wallet.".to_owned(),
            );
        }
        let account_address = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .address(&source_session_id, 1, 0)?;
        if account_address != record.address {
            exported.private_view_key.zeroize();
            return Err("The connected Ledger does not match this Fast Wallet account.".to_owned());
        }
        let mut payload = NativeFastWalletRegistrationPayload {
            identity: NativeFastWalletIdentity {
                id: record.id.clone(),
                label: record.label.clone(),
                address: record.address.clone(),
                network: record.network.clone(),
                restore_height: record.restore_height.to_string(),
                derivation_index: record.derivation_index.to_string(),
                scanner_status: record.scanner_status.clone(),
            },
            private_view_key: std::mem::take(&mut exported.private_view_key),
        };
        let subscription_id = notification_subscription_id(&app)?;
        let response = register_fast_wallet_with_scanner(
            &scanner_url,
            &record,
            &mut payload,
            subscription_id.as_deref(),
        )
        .await;
        payload.private_view_key.zeroize();
        let response = response?;
        apply_scanner_response(&mut record, &scanner_url, response)?;
        diagnostics::record(
            &app,
            "ledger.fast-wallet-scanner-enabled",
            &[("account", "1".to_owned())],
        );
        fast_wallet::update(&app, record)
    }
    .await;
    finish_ledger_view_key_export(&exports, &source.id);
    if result.is_err() {
        diagnostics::record(
            &app,
            "ledger.view-key-export-failed",
            &[("flow", "ledger-fast-scanner".to_owned())],
        );
    }
    result
}
#[tauri::command]
async fn refresh_fast_wallet_status(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: FastWalletIdInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    require_app_unlocked(&protection)?;
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    if record.status == "legacy-blocked" {
        return Ok(record);
    }
    let scanner_url = if record.scanner_url.is_empty() {
        return Ok(record);
    } else {
        fast_wallet::scanner_url(&record.scanner_url)?
    };
    let mut token = secure_store::load_fast_scanner_token(&record.id)?.ok_or_else(|| {
        "The scanner management credential is missing. Disable this test registration on the scanner and enable it again.".to_owned()
    })?;
    let result = get_fast_wallet_scanner_status(&scanner_url, &record.id, &token).await;
    token.zeroize();
    match result {
        Ok(Some(response)) => {
            if let Err(error) = apply_scanner_response(&mut record, &scanner_url, response) {
                let _ = fast_wallet::update(&app, record);
                return Err(error);
            }
        }
        Ok(None) => {
            record.status = "registration-error".to_owned();
            record.scanner_status = "missing".to_owned();
            record.scanner_checked_at = Some(now());
        }
        Err(error) => {
            record.status = "registration-error".to_owned();
            record.scanner_status = "unreachable".to_owned();
            record.scanner_checked_at = Some(now());
            let _ = fast_wallet::update(&app, record);
            return Err(error);
        }
    }
    fast_wallet::update(&app, record)
}
#[tauri::command]
async fn disable_fast_wallet(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: FastWalletIdInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    require_app_unlocked(&protection)?;
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    if !record.scanner_url.is_empty() {
        let scanner_url = fast_wallet::scanner_url(&record.scanner_url)?;
        let mut token = secure_store::load_fast_scanner_token(&record.id)?.ok_or_else(|| {
            "The scanner management credential is missing. Reset this test registration before retrying.".to_owned()
        })?;
        let result = delete_fast_wallet_scanner_watch(&scanner_url, &record.id, &token).await;
        token.zeroize();
        let response = result?;
        if response.identity_id != record.id {
            record.status = "server-mismatch".to_owned();
            record.scanner_status = "server-mismatch".to_owned();
            record.scanner_checked_at = Some(now());
            let _ = fast_wallet::update(&app, record);
            return Err("Fast Wallet scanner returned a mismatched identity.".to_owned());
        }
        record.scanner_status = response.scanner_status;
    }
    secure_store::delete_fast_scanner_token(&record.id)?;
    record.status = "disabled".to_owned();
    record.notifications_enabled = false;
    record.scanner_checked_at = Some(now());
    fast_wallet::update(&app, record)
}

#[derive(Serialize)]
struct ScannerRegisterRequest {
    identity_id: String,
    address: String,
    private_view_key: String,
    network: String,
    restore_height: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
}

async fn register_fast_wallet_with_scanner(
    scanner_url: &str,
    record: &fast_wallet::FastWalletRecord,
    payload: &mut NativeFastWalletRegistrationPayload,
    subscription_id: Option<&str>,
) -> Result<ScannerWatchResponse, String> {
    if payload.identity.id != record.id
        || payload.identity.address != record.address
        || payload.identity.network != record.network
        || payload.private_view_key.len() != 64
        || !payload
            .private_view_key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(
            "The native Fast Wallet scanner payload did not match the local identity.".to_owned(),
        );
    }
    let client = fast_scanner_client()?;
    let mut token = secure_store::ensure_fast_scanner_token(&record.id)?;
    let mut request = ScannerRegisterRequest {
        identity_id: record.id.clone(),
        address: record.address.clone(),
        private_view_key: std::mem::take(&mut payload.private_view_key),
        network: record.network.clone(),
        restore_height: record.restore_height,
        device_id: subscription_id.map(str::to_owned),
    };
    let call = client
        .post(format!("{scanner_url}/v1/fast-receive/watch"))
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(&token);
    let response = call.json(&request).send().await;
    request.private_view_key.zeroize();
    token.zeroize();
    let response = response.map_err(|_| "Fast Wallet scanner could not be reached.".to_owned())?;
    parse_scanner_response(response).await
}

fn notification_subscription_id(app: &AppHandle) -> Result<Option<String>, String> {
    let status = desktop_notifications::status(app)?;
    if status.installation.enabled {
        Ok(Some(status.installation.installation_id))
    } else {
        Ok(None)
    }
}

async fn get_fast_wallet_scanner_status(
    scanner_url: &str,
    identity_id: &str,
    token: &str,
) -> Result<Option<ScannerWatchResponse>, String> {
    fast_wallet::validate_id(identity_id)?;
    let client = fast_scanner_client()?;
    let call = client
        .get(format!("{scanner_url}/v1/fast-receive/watch/{identity_id}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(token);
    let response = call
        .send()
        .await
        .map_err(|_| "Fast Wallet scanner could not be reached.".to_owned())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    parse_scanner_response(response).await.map(Some)
}

async fn delete_fast_wallet_scanner_watch(
    scanner_url: &str,
    identity_id: &str,
    token: &str,
) -> Result<ScannerWatchResponse, String> {
    fast_wallet::validate_id(identity_id)?;
    let client = fast_scanner_client()?;
    let call = client
        .delete(format!("{scanner_url}/v1/fast-receive/watch/{identity_id}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(token);
    let response = call
        .send()
        .await
        .map_err(|_| "Fast Wallet scanner could not be reached.".to_owned())?;
    parse_scanner_response(response).await
}

fn fast_scanner_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Monero-Fast-Wallet-Desktop/0.1")
        .proxy(tor_transport::proxy()?)
        .build()
        .map_err(|_| "Fast Wallet scanner client could not be initialized.".to_owned())
}

async fn parse_scanner_response(
    response: reqwest::Response,
) -> Result<ScannerWatchResponse, String> {
    if !response.status().is_success() {
        return Err(format!(
            "Fast Wallet scanner request failed with HTTP {}.",
            response.status().as_u16()
        ));
    }
    response
        .json::<ScannerWatchResponse>()
        .await
        .map_err(|_| "Fast Wallet scanner returned an invalid response.".to_owned())
}

fn apply_scanner_response(
    record: &mut fast_wallet::FastWalletRecord,
    scanner_url: &str,
    response: ScannerWatchResponse,
) -> Result<(), String> {
    record.scanner_url = scanner_url.to_owned();
    record.scanner_checked_at = Some(now());
    if response.identity_id != record.id
        || response.network != record.network
        || response.restore_height != record.restore_height
    {
        record.status = "server-mismatch".to_owned();
        record.scanner_status = "server-mismatch".to_owned();
        return Err("Fast Wallet scanner returned a mismatched identity.".to_owned());
    }
    record.status = if response.status == "disabled" {
        "disabled".to_owned()
    } else {
        "enabled".to_owned()
    };
    record.scanner_status = if response.scanner_status.trim().is_empty() {
        response.status
    } else {
        response.scanner_status
    };
    record.last_scanned_height = Some(response.last_scanned_height);
    record.notifications_enabled = response.notifications_enabled;
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[tauri::command]
fn load_node_settings(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    network: String,
) -> Result<node_settings::NodeProfile, String> {
    require_app_unlocked(&protection)?;
    node_settings::load(&app, &network)
}
#[tauri::command]
fn save_node_settings(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    mut input: NodeSettingsInput,
) -> Result<node_settings::NodeProfile, String> {
    if let Err(error) = require_app_unlocked(&protection) {
        input.password.zeroize();
        return Err(error);
    }
    let existing = node_settings::load(&app, &input.network)?;
    let password_supplied = !input.password.trim().is_empty();
    let password_stored = !input.clear_password && (password_supplied || existing.password_stored);
    let profile = match node_settings::profile(
        input.mode,
        input.network.clone(),
        input.daemon_address,
        input.grpc_endpoint,
        input.trusted,
        input.use_ssl,
        input.username,
        input.proxy_address,
        password_stored,
    ) {
        Ok(profile) => profile,
        Err(error) => {
            input.password.zeroize();
            return Err(error);
        }
    };
    if input.clear_password {
        input.password.zeroize();
        secure_store::delete_node_daemon_password(&input.network)?;
    } else if password_supplied {
        secure_store::store_node_daemon_password(&input.network, input.password)?;
    } else {
        input.password.zeroize();
    }
    let profile = node_settings::save(&app, profile)?;
    if let Some(wallet_id) = input.wallet_id {
        // Never resolve the wallet-operation daemon locally. Monero Core sends
        // the unchanged hostname through SOCKS4a, so .onion resolution stays
        // inside the app's embedded Tor transport.
        let daemon_address = profile.daemon_address.clone();
        let (grpc_endpoint, _) = first_party_endpoint_with_dns_fallback(&profile.grpc_endpoint);
        let mut password = if profile.password_stored {
            secure_store::load_node_daemon_password(&profile.network)?.unwrap_or_default()
        } else {
            String::new()
        };
        let applied = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())
            .and_then(|native| {
                native.set_daemon(native_wallet::DaemonConfig {
                    wallet_id: &wallet_id,
                    address: &daemon_address,
                    trusted: profile.trusted,
                    use_ssl: profile.use_ssl,
                    username: &profile.username,
                    password: &password,
                    proxy_address: &profile.proxy_address,
                })?;
                native.set_grpc_endpoint(&wallet_id, &grpc_endpoint)
            });
        password.zeroize();
        applied?;
    }
    Ok(profile)
}

#[tauri::command]
async fn diagnose_connection_routes(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: ConnectionDiagnosticsInput,
) -> Result<ConnectionRoutesDiagnostic, String> {
    require_app_unlocked(&protection)?;
    let profile = node_settings::load(&app, &input.network)?;
    let tor_endpoint = profile.daemon_address.clone();
    let clearnet_endpoint = profile.grpc_endpoint.clone();
    let tor_task = tauri::async_runtime::spawn_blocking(move || probe_tor_route(&tor_endpoint));
    let clearnet_task =
        tauri::async_runtime::spawn_blocking(move || probe_clearnet_route(&clearnet_endpoint));
    let tor = tor_task
        .await
        .map_err(|_| "The Tor connection check ended unexpectedly.".to_owned())?;
    let clearnet = clearnet_task
        .await
        .map_err(|_| "The Clearnet connection check ended unexpectedly.".to_owned())?;
    Ok(ConnectionRoutesDiagnostic { tor, clearnet })
}

fn probe_tor_route(endpoint: &str) -> ConnectionRouteProbe {
    probe_route(endpoint, |host, port, timeout| {
        let mut stream = TcpStream::connect_timeout(
            &tor_transport::TOR_SOCKS_ADDRESS
                .parse()
                .map_err(|_| "The local Tor proxy address is invalid.".to_owned())?,
            timeout,
        )
        .map_err(|error| format!("{} ({error})", tor_transport::diagnostic_status()))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|error| error.to_string())?;
        stream
            .write_all(&[5, 1, 0])
            .map_err(|error| error.to_string())?;
        let mut greeting = [0_u8; 2];
        stream
            .read_exact(&mut greeting)
            .map_err(|error| format!("{} ({error})", tor_transport::diagnostic_status()))?;
        if greeting != [5, 0] {
            return Err("Tor SOCKS proxy rejected anonymous authentication.".to_owned());
        }
        let host_bytes = host.as_bytes();
        if host_bytes.is_empty() || host_bytes.len() > 255 || !host_bytes.is_ascii() {
            return Err("The Tor destination host is invalid.".to_owned());
        }
        let mut request = Vec::with_capacity(host_bytes.len() + 7);
        request.extend_from_slice(&[5, 1, 0, 3, host_bytes.len() as u8]);
        request.extend_from_slice(host_bytes);
        request.extend_from_slice(&port.to_be_bytes());
        stream
            .write_all(&request)
            .map_err(|error| error.to_string())?;
        let mut response = [0_u8; 4];
        stream
            .read_exact(&mut response)
            .map_err(|error| error.to_string())?;
        if response[0] != 5 || response[1] != 0 {
            return Err(format!(
                "Tor could not open the selected route (SOCKS {}).",
                response[1]
            ));
        }
        let remaining = match response[3] {
            1 => 4 + 2,
            3 => {
                let mut length = [0_u8; 1];
                stream
                    .read_exact(&mut length)
                    .map_err(|error| error.to_string())?;
                usize::from(length[0]) + 2
            }
            4 => 16 + 2,
            _ => return Err("Tor returned an invalid SOCKS response.".to_owned()),
        };
        let mut ignored = vec![0_u8; remaining];
        stream
            .read_exact(&mut ignored)
            .map_err(|error| error.to_string())?;
        probe_monero_daemon_api(&mut stream, host)
    })
}

fn probe_clearnet_route(endpoint: &str) -> ConnectionRouteProbe {
    probe_route(endpoint, |host, port, timeout| {
        let addresses = (host, port)
            .to_socket_addrs()
            .map_err(|error| format!("DNS: {error}"))?;
        let mut last_error = None;
        for address in addresses {
            match TcpStream::connect_timeout(&address, timeout) {
                Ok(mut stream) => {
                    stream
                        .set_read_timeout(Some(timeout))
                        .map_err(|error| error.to_string())?;
                    stream
                        .set_write_timeout(Some(timeout))
                        .map_err(|error| error.to_string())?;
                    return probe_grpc_transport(&mut stream);
                }
                Err(error) => last_error = Some(error.to_string()),
            }
        }
        Err(last_error.unwrap_or_else(|| "The endpoint has no usable address.".to_owned()))
    })
}

fn probe_monero_daemon_api(stream: &mut TcpStream, host: &str) -> Result<(), String> {
    let request = format!(
        "GET /get_height HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Tor daemon health request: {error}"))?;
    let response = read_bounded_response(stream, 32 * 1024)?;
    let text = String::from_utf8_lossy(&response);
    let status_ok = text.starts_with("HTTP/1.1 200 ") || text.starts_with("HTTP/1.0 200 ");
    if !status_ok || !text.contains("\"height\"") {
        return Err(
            "The selected Onion daemon did not return a valid /get_height response.".to_owned(),
        );
    }
    Ok(())
}

fn read_bounded_response(stream: &mut TcpStream, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = Vec::new();
    let mut chunk = [0_u8; 2048];
    while response.len() < limit {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(bytes) => {
                response.extend_from_slice(&chunk[..bytes]);
                if response.windows(8).any(|window| window == b"\"height\"") {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) && !response.is_empty() =>
            {
                break;
            }
            Err(error) => return Err(format!("Health response: {error}")),
        }
    }
    if response.is_empty() {
        return Err("The health endpoint returned no response.".to_owned());
    }
    Ok(response)
}

fn probe_grpc_transport(stream: &mut TcpStream) -> Result<(), String> {
    // A gRPC server is HTTP/2. Send the mandatory client connection preface
    // plus an empty SETTINGS frame and require the server's SETTINGS frame.
    // This distinguishes a functioning ScanPack API from a merely open port.
    const PREFACE_AND_SETTINGS: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\0\0\0\x04\0\0\0\0\0";
    stream
        .write_all(PREFACE_AND_SETTINGS)
        .map_err(|error| format!("gRPC health request: {error}"))?;
    let mut header = [0_u8; 9];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("gRPC health response: {error}"))?;
    let length =
        (usize::from(header[0]) << 16) | (usize::from(header[1]) << 8) | usize::from(header[2]);
    let stream_id = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) & 0x7fff_ffff;
    if header[3] != 4 || stream_id != 0 || length > 65_535 {
        return Err("The Clearnet endpoint did not answer as a gRPC/HTTP2 service.".to_owned());
    }
    let mut settings = vec![0_u8; length];
    stream
        .read_exact(&mut settings)
        .map_err(|error| format!("gRPC SETTINGS response: {error}"))?;
    Ok(())
}

fn connectivity_routes() -> &'static Mutex<HashMap<String, ConnectivityRouteState>> {
    CLEARNET_CONNECTIVITY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tor_connectivity_routes() -> &'static Mutex<HashMap<String, ConnectivityRouteState>> {
    TOR_CONNECTIVITY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_clearnet_connectivity(network: &str, state: ConnectivityRouteState) {
    if let Ok(mut routes) = connectivity_routes().lock() {
        routes.insert(network.to_owned(), state);
    }
}

fn set_tor_connectivity(network: &str, state: ConnectivityRouteState) {
    if let Ok(mut routes) = tor_connectivity_routes().lock() {
        routes.insert(network.to_owned(), state);
    }
}

/// Keep the last service-level success visible while the next periodic probe
/// runs. A health check is not a disconnect: only a failed Onion daemon or
/// gRPC protocol response may replace a confirmed green route with an error.
/// A changed endpoint starts in checking state because the previous result no
/// longer describes the configured route.
fn mark_connectivity_checking(
    routes: &Mutex<HashMap<String, ConnectivityRouteState>>,
    network: &str,
    endpoint: &str,
) {
    if let Ok(mut routes) = routes.lock() {
        let preserve_confirmed = routes
            .get(network)
            .is_some_and(|state| state.connected && state.endpoint == endpoint);
        if !preserve_confirmed {
            routes.insert(
                network.to_owned(),
                ConnectivityRouteState {
                    phase: "checking".to_owned(),
                    connected: false,
                    endpoint: endpoint.to_owned(),
                    checked_at_ms: connectivity_now_ms(),
                    elapsed_ms: None,
                    error: None,
                },
            );
        }
    }
}

fn start_desktop_connectivity_monitor(app: AppHandle) {
    for network in ["mainnet", "testnet", "stagenet"] {
        let tor_app = app.clone();
        let tor_network = network.to_owned();
        let tor_error_network = tor_network.clone();
        let tor_thread_name = format!("mfw-tor-health-{network}");
        if let Err(error) = std::thread::Builder::new()
            .name(tor_thread_name)
            .spawn(move || loop {
                match node_settings::load(&tor_app, &tor_network) {
                    Ok(profile) => {
                        mark_connectivity_checking(
                            tor_connectivity_routes(),
                            &tor_network,
                            &profile.daemon_address,
                        );
                        let probe = probe_tor_route(&profile.daemon_address);
                        set_tor_connectivity(
                            &tor_network,
                            ConnectivityRouteState {
                                phase: if probe.connected {
                                    "connected"
                                } else {
                                    "error"
                                }
                                .to_owned(),
                                connected: probe.connected,
                                endpoint: probe.endpoint,
                                checked_at_ms: connectivity_now_ms(),
                                elapsed_ms: probe.elapsed_ms,
                                error: probe.error,
                            },
                        );
                    }
                    Err(error) => set_tor_connectivity(
                        &tor_network,
                        ConnectivityRouteState {
                            phase: "error".to_owned(),
                            connected: false,
                            endpoint: String::new(),
                            checked_at_ms: connectivity_now_ms(),
                            elapsed_ms: None,
                            error: Some(error),
                        },
                    ),
                }
                std::thread::sleep(Duration::from_secs(15));
            })
        {
            eprintln!(
                "MONERO_DESKTOP_CONNECTIVITY tor-monitor-start-failed network={tor_error_network} error={error}"
            );
        }

        let app = app.clone();
        let network = network.to_owned();
        let error_network = network.clone();
        let thread_name = format!("mfw-clearnet-{network}");
        if let Err(error) = std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || loop {
                let profile = node_settings::load(&app, &network);
                match profile {
                    Ok(profile) => {
                        mark_connectivity_checking(
                            connectivity_routes(),
                            &network,
                            &profile.grpc_endpoint,
                        );
                        let probe = probe_clearnet_route(&profile.grpc_endpoint);
                        set_clearnet_connectivity(
                            &network,
                            ConnectivityRouteState {
                                phase: if probe.connected {
                                    "connected"
                                } else {
                                    "error"
                                }
                                .to_owned(),
                                connected: probe.connected,
                                endpoint: probe.endpoint,
                                checked_at_ms: connectivity_now_ms(),
                                elapsed_ms: probe.elapsed_ms,
                                error: probe.error,
                            },
                        );
                    }
                    Err(error) => set_clearnet_connectivity(
                        &network,
                        ConnectivityRouteState {
                            phase: "error".to_owned(),
                            connected: false,
                            endpoint: String::new(),
                            checked_at_ms: connectivity_now_ms(),
                            elapsed_ms: None,
                            error: Some(error),
                        },
                    ),
                }
                std::thread::sleep(Duration::from_secs(15));
            })
        {
            eprintln!(
                "MONERO_DESKTOP_CONNECTIVITY monitor-start-failed network={error_network} error={error}"
            );
        }
    }
}

#[tauri::command]
fn connectivity_status(
    app: AppHandle,
    input: ConnectivityStatusInput,
) -> Result<ConnectivityStatus, String> {
    let profile = node_settings::load(&app, &input.network)?;
    let tor_runtime = tor_transport::status_snapshot();
    let tor_state = tor_connectivity_routes()
        .lock()
        .ok()
        .and_then(|routes| routes.get(&input.network).cloned())
        .unwrap_or(ConnectivityRouteState {
            phase: tor_runtime.phase,
            connected: false,
            endpoint: profile.daemon_address,
            checked_at_ms: tor_runtime.checked_at_ms,
            elapsed_ms: None,
            error: if tor_runtime.worker_alive {
                tor_runtime.error
            } else {
                Some("Embedded Tor worker is not running.".to_owned())
            },
        });
    let clearnet = connectivity_routes()
        .lock()
        .ok()
        .and_then(|routes| routes.get(&input.network).cloned())
        .unwrap_or(ConnectivityRouteState {
            phase: "starting".to_owned(),
            connected: false,
            endpoint: profile.grpc_endpoint,
            checked_at_ms: 0,
            elapsed_ms: None,
            error: None,
        });
    Ok(ConnectivityStatus {
        tor: tor_state,
        clearnet,
    })
}

fn connectivity_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn probe_route<F>(endpoint: &str, connect: F) -> ConnectionRouteProbe
where
    F: FnOnce(&str, u16, Duration) -> Result<(), String>,
{
    let label = endpoint.trim().to_owned();
    let started = Instant::now();
    let result = parse_connection_endpoint(&label)
        .and_then(|(host, port)| connect(&host, port, Duration::from_secs(8)));
    match result {
        Ok(()) => ConnectionRouteProbe {
            connected: true,
            endpoint: label,
            elapsed_ms: Some(started.elapsed().as_millis()),
            error: None,
        },
        Err(error) => ConnectionRouteProbe {
            connected: false,
            endpoint: label,
            elapsed_ms: None,
            error: Some(error),
        },
    }
}

fn parse_connection_endpoint(endpoint: &str) -> Result<(String, u16), String> {
    let without_scheme = endpoint
        .split_once("://")
        .map(|(_, value)| value)
        .unwrap_or(endpoint);
    let authority = without_scheme.split('/').next().unwrap_or_default();
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "The endpoint must include a port.".to_owned())?;
    let checked_host = host.trim().to_ascii_lowercase();
    if checked_host.is_empty()
        || checked_host.len() > 253
        || checked_host.starts_with('.')
        || checked_host.ends_with('.')
        || checked_host.contains("..")
        || !checked_host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    {
        return Err("The endpoint host is invalid.".to_owned());
    }
    let checked_port = port
        .parse::<u16>()
        .map_err(|_| "The endpoint port is invalid.".to_owned())?;
    if checked_port == 0 {
        return Err("The endpoint port is invalid.".to_owned());
    }
    Ok((checked_host, checked_port))
}
#[tauri::command]
fn set_daemon(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    mut input: DaemonInput,
) -> Result<(), String> {
    if let Err(error) = require_app_unlocked(&protection) {
        input.password.zeroize();
        return Err(error);
    }
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .set_daemon(native_wallet::DaemonConfig {
            wallet_id: &input.wallet_id,
            address: &input.address,
            trusted: input.trusted,
            use_ssl: input.use_ssl,
            username: input.username.as_deref().unwrap_or(""),
            password: &input.password,
            // This legacy command is still permissioned for compatibility,
            // but it may never create a direct daemon route.
            proxy_address: tor_transport::TOR_SOCKS_ADDRESS,
        });
    input.password.zeroize();
    result
}
#[tauri::command]
async fn start_wallet_refresh(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .start_refresh(&input.wallet_id)
}

#[tauri::command]
fn network_sync_status(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    network_name: String,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let network_code = network(&network_name)?;
    try_lock_native_wallet(&app, &state, "network-sync-status")?.network_sync_status(network_code)
}
#[tauri::command]
fn stop_wallet_refresh(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .stop_refresh(&input.wallet_id)
}
#[tauri::command]
fn wallet_address(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    let address_index = checked_account_index(input.address_index)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .address(&input.wallet_id, account_index, address_index)
}
#[tauri::command]
fn validate_recipient_address(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: ValidateRecipientAddressInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let network = network(&input.network)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .validate_recipient_address(input.address.trim(), network)
}

#[tauri::command]
fn verify_mfw_name_record_address(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: VerifyMfwNameRecordAddressInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "mfwNameResolution",
        "MFW names are not enabled in this safe release.",
    )?;
    let network = network(&input.network)?;
    let expected_name = input.expected_name.trim().as_bytes();
    if expected_name.is_empty() || expected_name.len() > 67 {
        return Err("MFW name is invalid.".to_owned());
    }
    let mut address = [0_u8; fast_wallet_protocol::ffi::MFW_MONERO_ADDRESS_BYTES];
    let status = if input.signing_owner_public_key_hex.is_empty() {
        let record = decode_bounded_hex(&input.record_payload_hex, 89, 152, "MFW record")?;
        unsafe {
            fast_wallet_protocol::ffi::tex8_mfw_verify_and_encode_legacy_name_address_v1(
                record.as_ptr(),
                record.len(),
                expected_name.as_ptr(),
                expected_name.len(),
                network,
                address.as_mut_ptr(),
                address.len(),
            )
        }
    } else {
        let record = decode_bounded_hex(&input.record_payload_hex, 189, 251, "MFW record")?;
        let signing_owner = decode_bounded_hex(
            &input.signing_owner_public_key_hex,
            32,
            32,
            "MFW signing owner key",
        )?;
        unsafe {
            fast_wallet_protocol::ffi::tex8_mfw_verify_and_encode_name_address_v1(
                record.as_ptr(),
                record.len(),
                expected_name.as_ptr(),
                expected_name.len(),
                network,
                signing_owner.as_ptr(),
                signing_owner.len(),
                address.as_mut_ptr(),
                address.len(),
            )
        }
    };
    if status != fast_wallet_protocol::ffi::OK {
        return Err("MFW name record could not be verified.".to_owned());
    }
    let address =
        String::from_utf8(address.to_vec()).map_err(|_| "MFW address is invalid.".to_owned())?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .validate_recipient_address(&address, network)
}

#[tauri::command]
fn list_mfw_names(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<mfw_names::OwnedNameRecord>, String> {
    require_app_unlocked(&protection)?;
    mfw_names::list(&app)
}

#[tauri::command]
fn resolve_mfw_name_for_payment(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: ResolveMfwNameInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let network_code = network(&input.network)?;
    let address = mfw_name_resolver::resolve_payment(&input.name, &input.network)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .validate_recipient_address(&address, network_code)
}

#[tauri::command]
fn check_mfw_name_availability(
    protection: State<'_, AppProtectionState>,
    input: CheckMfwNameAvailabilityInput,
) -> Result<mfw_name_resolver::Availability, String> {
    require_app_unlocked(&protection)?;
    network(&input.network)?;
    mfw_name_resolver::availability(&input.name, &input.network)
}

fn mfw_transaction_wallet_id(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    wallet_registration_id: &str,
    current_wallet_id: &str,
    diagnostic_flow: &str,
) -> Result<String, String> {
    require_wallet_session(sessions, wallet_registration_id, current_wallet_id)?;
    let registry = wallet_registry::list(app)?;
    let registration = registry
        .wallets
        .iter()
        .find(|wallet| wallet.id == wallet_registration_id)
        .cloned()
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    if registration.kind == "hardware"
        && registration.role.as_deref().unwrap_or("standard") == "standard"
    {
        ensure_ledger_hardware_session(app, state, sessions, &registration, diagnostic_flow)
    } else {
        Ok(current_wallet_id.to_owned())
    }
}

#[tauri::command]
fn prepare_mfw_name_registration(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    input: PrepareMfwNameRegistrationInput,
) -> Result<MfwPreparedResponse, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "mfwNameRegistration",
        "MFW name registration is not enabled in this release.",
    )?;
    require_wallet_session(&sessions, &input.wallet_registration_id, &input.wallet_id)?;
    let genesis = release_features::mfw_name_genesis(&input.network)
        .ok_or_else(|| "MFW genesis parameters are not configured for this network.".to_owned())?;
    if input.years == 0 || input.years > genesis.maximum_term_years {
        return Err("The selected MFW registration term is not supported.".to_owned());
    }
    let canonical_name = mfw_names::canonical_name(&input.name)?;
    let snapshot_raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .snapshot(&input.wallet_id)?;
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_raw)
        .map_err(|_| "The native wallet snapshot was invalid.".to_owned())?;
    if snapshot
        .get("synchronized")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err("Synchronize the owner wallet before registering an MFW name.".to_owned());
    }
    let availability = mfw_name_resolver::availability(&canonical_name, &input.network)?;
    if !matches!(
        availability.status.as_str(),
        "available" | "available-again"
    ) {
        return Err(format!(
            "{} is not available for registration ({status}).",
            canonical_name,
            status = availability.status
        ));
    }
    let network_code = network(&input.network)?;
    let account_index = checked_account_index(input.account_index)?;
    let address_index = checked_account_index(input.address_index)?;
    // The open wallet owns and pays for the name. Its published receive
    // address may deliberately point to any valid Monero address, including
    // one held on another device or in another wallet.
    let address = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .validate_recipient_address(input.address.trim(), network_code)?;
    let transaction_wallet_id = mfw_transaction_wallet_id(
        &app,
        &state,
        &sessions,
        &input.wallet_registration_id,
        &input.wallet_id,
        "mfw-name-registration",
    )?;
    let mut raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_mfw_name_registration(
            &transaction_wallet_id,
            &canonical_name,
            &address,
            network_code,
            &genesis.registry_address,
            input.priority.as_deref().unwrap_or("low"),
            account_index,
        )?;
    let mut prepared: NativeMfwPrepared = serde_json::from_str(&raw)
        .map_err(|_| "The native MFW registration review was invalid.".to_owned())?;
    raw.zeroize();
    let name_id = mfw_names::identity_id(&input.wallet_registration_id, &canonical_name)?;
    let result = (|| {
        require_hex(&prepared.owner_private_key_hex, 32, "MFW owner private key")?;
        require_hex(&prepared.owner_public_key_hex, 32, "MFW owner public key")?;
        require_hex(&prepared.commit_salt_hex, 16, "MFW commit salt")?;
        let owner_state = mfw_names::OwnerState {
            version: 1,
            canonical_name: canonical_name.clone(),
            network: input.network.clone(),
            owner_private_key_hex: prepared.owner_private_key_hex.clone(),
            owner_public_key_hex: prepared.owner_public_key_hex.clone(),
            commit_salt_hex: prepared.commit_salt_hex.clone(),
        };
        let record = mfw_names::new_record(
            name_id.clone(),
            canonical_name.clone(),
            input.wallet_registration_id.clone(),
            format!("{account_index}-{address_index}"),
            address,
            input.network,
            input.years,
            prepared.owner_public_key_hex.clone(),
        )?;
        let encoded_owner = mfw_names::encode_owner_state(&owner_state)?;
        secure_store::store_mfw_name_owner_state(&name_id, encoded_owner)?;
        if let Err(error) = mfw_names::upsert(&app, record) {
            let _ = secure_store::delete_mfw_name_owner_state(&name_id);
            return Err(error);
        }
        if let Err(error) = register_mfw_approval(
            &approvals,
            &transaction_wallet_id,
            &genesis.registry_address,
            &prepared.prepared_transaction,
            MfwPendingApproval {
                record_id: name_id.clone(),
                kind: "commit".to_owned(),
                years: input.years,
            },
        ) {
            let _ = mfw_names::remove(&app, &name_id);
            let _ = secure_store::delete_mfw_name_owner_state(&name_id);
            return Err(error);
        }
        Ok(MfwPreparedResponse {
            name_id,
            canonical_name,
            kind: "commit".to_owned(),
            years: input.years,
            recovery_export_required: true,
            prepared_transaction: prepared.prepared_transaction.clone(),
        })
    })();
    prepared.owner_private_key_hex.zeroize();
    prepared.commit_salt_hex.zeroize();
    result
}

#[tauri::command]
fn prepare_mfw_name_claim(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    input: PrepareMfwNameClaimInput,
) -> Result<MfwPreparedResponse, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "mfwNameRegistration",
        "MFW name registration is not enabled in this release.",
    )?;
    require_wallet_session(&sessions, &input.wallet_registration_id, &input.wallet_id)?;
    let record = mfw_names::get(&app, &input.name_id)?;
    if record.wallet_registration_id != input.wallet_registration_id
        || record.stage != "reveal-ready"
    {
        return Err("This MFW name is not ready to reveal.".to_owned());
    }
    let genesis = release_features::mfw_name_genesis(&record.network)
        .ok_or_else(|| "MFW genesis parameters are not configured for this network.".to_owned())?;
    require_mfw_commit_window(&state, &input.wallet_id, &record, &genesis)?;
    let network_code = network(&record.network)?;
    let transaction_wallet_id = mfw_transaction_wallet_id(
        &app,
        &state,
        &sessions,
        &input.wallet_registration_id,
        &input.wallet_id,
        "mfw-name-claim",
    )?;
    let mut owner = load_mfw_owner_state(&record)?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_mfw_name_claim(
            &transaction_wallet_id,
            &record.canonical_name,
            &record.address,
            network_code,
            &genesis.registry_address,
            record.term_years,
            input.priority.as_deref().unwrap_or("low"),
            checked_account_index(input.account_index)?,
            &owner.owner_private_key_hex,
            &owner.commit_salt_hex,
        );
    owner.zeroize();
    prepare_existing_mfw_response(
        raw?,
        &approvals,
        &transaction_wallet_id,
        &genesis.registry_address,
        &record,
        "claim",
        record.term_years,
    )
}

#[tauri::command]
fn prepare_mfw_name_transition(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    input: PrepareMfwNameTransitionInput,
) -> Result<MfwPreparedResponse, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "mfwNameRegistration",
        "MFW name registration is not enabled in this release.",
    )?;
    require_wallet_session(&sessions, &input.wallet_registration_id, &input.wallet_id)?;
    if !matches!(input.operation.as_str(), "update" | "renew" | "revoke") {
        return Err("Unsupported MFW transition.".to_owned());
    }
    let mut record = mfw_names::get(&app, &input.name_id)?;
    let original_record = record.clone();
    if record.wallet_registration_id != input.wallet_registration_id || record.stage != "active" {
        return Err("Only an active MFW name owned by the open wallet can be changed.".to_owned());
    }
    let genesis = release_features::mfw_name_genesis(&record.network)
        .ok_or_else(|| "MFW genesis parameters are not configured for this network.".to_owned())?;
    let years = input.years.unwrap_or(record.term_years);
    if years == 0 || years > genesis.maximum_term_years {
        return Err("The selected MFW renewal term is not supported.".to_owned());
    }
    let mut owner = load_mfw_owner_state(&record)?;
    let predecessor = mfw_name_resolver::resolve_predecessor(
        &record.canonical_name,
        &record.network,
        &owner.owner_public_key_hex,
    )?;
    let network_code = network(&record.network)?;
    let address = if input.operation == "update" {
        let requested = input
            .address
            .as_deref()
            .ok_or_else(|| "Choose a new Monero address for this MFW name.".to_owned())?;
        let validated = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .validate_recipient_address(requested.trim(), network_code)?;
        if validated == record.address {
            return Err("The new MFW address must differ from the current address.".to_owned());
        }
        record.pending_address = Some(validated.clone());
        validated
    } else {
        record.address.clone()
    };
    let destination = if input.operation == "renew" {
        genesis.registry_address.clone()
    } else {
        address.clone()
    };
    let transaction_wallet_id = match mfw_transaction_wallet_id(
        &app,
        &state,
        &sessions,
        &input.wallet_registration_id,
        &input.wallet_id,
        "mfw-name-transition",
    ) {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            owner.zeroize();
            return Err(error);
        }
    };
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_mfw_name_transition(
            &transaction_wallet_id,
            &input.operation,
            &record.canonical_name,
            &address,
            network_code,
            &genesis.registry_address,
            years,
            input.priority.as_deref().unwrap_or("low"),
            checked_account_index(input.account_index)?,
            &owner.owner_private_key_hex,
            &predecessor.record_payload_hex,
            &predecessor.signing_owner_public_key_hex,
        );
    owner.zeroize();
    let raw = raw?;
    if input.operation == "update" {
        mfw_names::upsert(&app, record.clone())?;
    }
    let result = prepare_existing_mfw_response(
        raw,
        &approvals,
        &transaction_wallet_id,
        &destination,
        &record,
        &input.operation,
        years,
    );
    if result.is_err() && input.operation == "update" {
        let _ = mfw_names::upsert(&app, original_record);
    }
    result
}

#[tauri::command]
async fn export_mfw_name_recovery(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: ExportMfwNameRecoveryInput,
) -> Result<mfw_names::OwnedNameRecord, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "mfwNameRegistration",
        "MFW name recovery is not enabled in this release.",
    )?;
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Export the encrypted MFW owner recovery file",
    )
    .await?;
    let record = mfw_names::get(&app, &input.name_id)?;
    let mut owner = load_mfw_owner_state(&record)?;
    let recovery_password = Zeroizing::new(input.recovery_password.into_bytes());
    let bundle = Zeroizing::new(mfw_names::export_recovery(&owner, &recovery_password)?);
    owner.zeroize();
    let file_name = format!(
        "{}-owner.mfw-recovery",
        record.canonical_name.trim_end_matches(".mfw")
    );
    let path = rfd::FileDialog::new()
        .add_filter("MFW owner recovery", &["mfw-recovery"])
        .set_file_name(&file_name)
        .save_file()
        .ok_or_else(|| "MFW recovery export was cancelled.".to_owned())?;
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| {
                "Choose a new file name; an existing recovery file will not be overwritten."
                    .to_owned()
            })?;
        file.write_all(&bundle)
            .and_then(|_| file.sync_all())
            .map_err(|_| "MFW recovery file could not be saved.".to_owned())?;
        mfw_names::mark_recovery_exported(&app, record)
    })();
    result
}

#[tauri::command]
async fn import_mfw_name_recovery(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    mut input: ImportMfwNameRecoveryInput,
) -> Result<mfw_names::OwnedNameRecord, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "mfwNameRegistration",
        "MFW name recovery is not enabled in this release.",
    )?;
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Import an encrypted MFW owner recovery file",
    )
    .await?;
    let canonical_name = mfw_names::canonical_name(&input.name)?;
    let (resolution, address) =
        mfw_name_resolver::resolve_for_import(&canonical_name, &input.network)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .validate_recipient_address(&address, network(&input.network)?)?;
    let path = rfd::FileDialog::new()
        .add_filter("MFW owner recovery", &["mfw-recovery"])
        .pick_file()
        .ok_or_else(|| "MFW recovery import was cancelled.".to_owned())?;
    let bundle = Zeroizing::new(
        fs::read(path).map_err(|_| "MFW recovery file could not be read.".to_owned())?,
    );
    let recovery_password = Zeroizing::new(input.recovery_password.into_bytes());
    let mut owner =
        mfw_names::import_recovery(&bundle, &canonical_name, &input.network, &recovery_password)?;
    if owner.owner_public_key_hex != resolution.owner_public_key_hex {
        owner.zeroize();
        return Err("MFW recovery owner does not match the finalized chain record.".to_owned());
    }
    let name_id = mfw_names::identity_id(&input.wallet_registration_id, &canonical_name)?;
    let term_years =
        mfw_names::estimated_term_years(resolution.record_height, resolution.expiry_height)?;
    let source_txid_hex = resolution.source_txid_hex.clone();
    let mut record = mfw_names::new_record(
        name_id.clone(),
        canonical_name,
        input.wallet_registration_id,
        format!("mfw-recovered-{source_txid_hex}"),
        address,
        input.network,
        term_years,
        resolution.owner_public_key_hex,
    )?;
    record.stage = "active".to_owned();
    record.sequence = resolution.sequence;
    record.source_txid_hex = Some(source_txid_hex);
    record.expiry_height = Some(resolution.expiry_height);
    record.last_chain_tip_height = Some(resolution.chain_tip_height);
    record.recovery_exported_at = Some(now());
    let encoded_owner = mfw_names::encode_owner_state(&owner)?;
    owner.zeroize();
    secure_store::store_mfw_name_owner_state(&name_id, encoded_owner)?;
    if let Err(error) = mfw_names::upsert(&app, record) {
        let _ = secure_store::delete_mfw_name_owner_state(&name_id);
        return Err(error);
    }
    mfw_names::get(&app, &name_id)
}

#[tauri::command]
fn refresh_mfw_name(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: RefreshMfwNameInput,
) -> Result<mfw_names::OwnedNameRecord, String> {
    require_app_unlocked(&protection)?;
    release_features::require(
        "mfwNameRegistration",
        "MFW name registration is not enabled in this release.",
    )?;
    let mut record = mfw_names::get(&app, &input.name_id)?;
    if record.stage == "commit-pending" {
        let wallet_id = input
            .wallet_id
            .as_deref()
            .ok_or_else(|| "Open the owner wallet to refresh the MFW commit.".to_owned())?;
        let raw = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .transactions(wallet_id)?;
        let transactions: Vec<serde_json::Value> = serde_json::from_str(&raw)
            .map_err(|_| "The native transaction history was invalid.".to_owned())?;
        if let Some(transaction) = transactions.iter().find(|transaction| {
            transaction.get("hash").and_then(serde_json::Value::as_str)
                == record.commit_txid_hex.as_deref()
        }) {
            if transaction
                .get("failed")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                record.stage = "failed".to_owned();
            } else if transaction
                .get("pending")
                .and_then(serde_json::Value::as_bool)
                == Some(false)
            {
                let confirmations = json_u64_string(transaction, "confirmations")?;
                let block_height = json_u64_string(transaction, "blockHeight")?;
                let genesis =
                    release_features::mfw_name_genesis(&record.network).ok_or_else(|| {
                        "MFW genesis parameters are not configured for this network.".to_owned()
                    })?;
                if confirmations > genesis.commit_reveal_window_blocks {
                    record.stage = "failed".to_owned();
                } else if block_height > 0 && confirmations >= genesis.commit_maturity_blocks {
                    record.stage = "reveal-ready".to_owned();
                    record.commit_height = Some(block_height);
                    record.last_chain_tip_height =
                        Some(block_height.saturating_add(confirmations.saturating_sub(1)));
                }
            }
        }
        return mfw_names::upsert(&app, record);
    }
    let resolution = mfw_name_resolver::resolve(&record.canonical_name)?;
    if matches!(
        record.stage.as_str(),
        "claim-pending" | "update-pending" | "renew-pending" | "revoke-pending"
    ) {
        if !matches!(resolution.status.as_str(), "finalized" | "revoked")
            || resolution.source_txid_hex != record.source_txid_hex.as_deref().unwrap_or("")
            || resolution.confirmations < 15
        {
            return Ok(record);
        }
        let address = mfw_name_resolver::validate_expected_finalization(&resolution, &record)?;
        record = mfw_names::reconcile_finalized(
            record,
            &resolution.status,
            Some(&address),
            resolution.sequence,
            resolution.expiry_height,
            resolution.chain_tip_height,
            &resolution.source_txid_hex,
        )?;
        return mfw_names::upsert(&app, record);
    }
    if record.stage == "active" {
        let expected_owner = record.owner_public_key_hex.as_deref().unwrap_or("");
        if resolution.canonical_name != record.canonical_name
            || resolution.network != record.network
            || resolution.owner_public_key_hex != expected_owner
        {
            return Err("MFW resolver record does not match the local owner.".to_owned());
        }
        if resolution.status == "expired" || resolution.expiry_height <= resolution.chain_tip_height
        {
            mfw_name_resolver::verified_address(
                &resolution,
                &record.canonical_name,
                &record.network,
            )?;
            record.stage = "expired".to_owned();
        } else {
            record.address =
                mfw_name_resolver::validate_expected_finalization(&resolution, &record)?;
        }
        record.sequence = resolution.sequence;
        record.source_txid_hex = Some(resolution.source_txid_hex);
        record.expiry_height = Some(resolution.expiry_height);
        record.last_chain_tip_height = Some(resolution.chain_tip_height);
        return mfw_names::upsert(&app, record);
    }
    Ok(record)
}

#[tauri::command]
async fn remove_mfw_name_local(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    mut input: RemoveMfwNameLocalInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Remove this local MFW name and its owner key",
    )
    .await?;
    let record = mfw_names::get(&app, &input.name_id)?;
    if !matches!(record.stage.as_str(), "revoked" | "expired" | "failed") {
        return Err("Revoke the MFW name before removing its local owner key.".to_owned());
    }
    secure_store::delete_mfw_name_owner_state(&record.id)?;
    mfw_names::remove(&app, &record.id)?;
    Ok(())
}

fn require_wallet_session(
    sessions: &WalletSessionState,
    registration_id: &str,
    native_wallet_id: &str,
) -> Result<(), String> {
    let active = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(registration_id)
        .cloned()
        .ok_or_else(|| "Open the selected owner wallet before managing an MFW name.".to_owned())?;
    if active != native_wallet_id {
        return Err("The selected MFW owner wallet session changed. Open it again.".to_owned());
    }
    Ok(())
}

fn load_mfw_owner_state(
    record: &mfw_names::OwnedNameRecord,
) -> Result<mfw_names::OwnerState, String> {
    let mut encoded = secure_store::load_mfw_name_owner_state(&record.id)?
        .ok_or_else(|| "This device no longer has the MFW owner key.".to_owned())?;
    let state = mfw_names::decode_owner_state(&encoded);
    encoded.zeroize();
    let state = state?;
    if state.canonical_name != record.canonical_name
        || state.network != record.network
        || Some(state.owner_public_key_hex.as_str()) != record.owner_public_key_hex.as_deref()
    {
        return Err("Protected MFW owner state does not match its public metadata.".to_owned());
    }
    Ok(state)
}

fn register_mfw_approval(
    approvals: &PendingTransactionApprovalState,
    wallet_id: &str,
    destination: &str,
    prepared: &serde_json::Value,
    mfw: MfwPendingApproval,
) -> Result<(), String> {
    let pending_id = prepared
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The native MFW transaction review has no pending ID.".to_owned())?;
    let status = prepared
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let tx_count = prepared
        .get("txCount")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or(0);
    if status != "ok" || tx_count != 1 {
        return Err("The native MFW operation did not prepare exactly one transaction.".to_owned());
    }
    let amount_atomic = prepared
        .get("amountAtomic")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The native MFW transaction review has no amount.".to_owned())?;
    let fee_atomic = prepared
        .get("feeAtomic")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The native MFW transaction review has no fee.".to_owned())?;
    let mut pending = approvals
        .0
        .lock()
        .map_err(|_| "Transaction approval state is busy.".to_owned())?;
    let current_time = now();
    pending.retain(|_, approval| approval.expires_at > current_time);
    pending.insert(
        pending_id.to_owned(),
        PendingTransactionApproval {
            wallet_id: wallet_id.to_owned(),
            address: destination.to_owned(),
            amount_atomic: amount_atomic.to_owned(),
            fee_atomic: fee_atomic.to_owned(),
            expires_at: current_time.saturating_add(120),
            mfw: Some(mfw),
        },
    );
    Ok(())
}

fn prepare_existing_mfw_response(
    raw: String,
    approvals: &PendingTransactionApprovalState,
    wallet_id: &str,
    destination: &str,
    record: &mfw_names::OwnedNameRecord,
    kind: &str,
    years: u32,
) -> Result<MfwPreparedResponse, String> {
    let mut raw = raw;
    let mut prepared: NativeMfwPrepared = serde_json::from_str(&raw)
        .map_err(|_| "The native MFW transaction review was invalid.".to_owned())?;
    raw.zeroize();
    let result = register_mfw_approval(
        approvals,
        wallet_id,
        destination,
        &prepared.prepared_transaction,
        MfwPendingApproval {
            record_id: record.id.clone(),
            kind: kind.to_owned(),
            years,
        },
    )
    .map(|_| MfwPreparedResponse {
        name_id: record.id.clone(),
        canonical_name: record.canonical_name.clone(),
        kind: kind.to_owned(),
        years,
        recovery_export_required: false,
        prepared_transaction: prepared.prepared_transaction.clone(),
    });
    prepared.owner_private_key_hex.zeroize();
    prepared.commit_salt_hex.zeroize();
    result
}

fn require_hex(value: &str, bytes: usize, label: &str) -> Result<(), String> {
    (value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
    .then_some(())
    .ok_or_else(|| format!("{label} is invalid."))
}

fn json_u64_string(value: &serde_json::Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(|field| {
            field
                .as_u64()
                .or_else(|| field.as_str().and_then(|text| text.parse().ok()))
        })
        .ok_or_else(|| format!("The native transaction has no valid {key}."))
}

fn require_mfw_commit_window(
    state: &NativeWalletState,
    wallet_id: &str,
    record: &mfw_names::OwnedNameRecord,
    genesis: &release_features::MfwNameGenesisConfig,
) -> Result<(), String> {
    let commit_txid = record
        .commit_txid_hex
        .as_deref()
        .ok_or_else(|| "The MFW registration has no commit transaction.".to_owned())?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .transactions(wallet_id)?;
    let transactions: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|_| "The native transaction history was invalid.".to_owned())?;
    let transaction = transactions
        .iter()
        .find(|transaction| {
            transaction.get("hash").and_then(serde_json::Value::as_str) == Some(commit_txid)
        })
        .ok_or_else(|| "The MFW commit is not present in the owner wallet.".to_owned())?;
    let failed = transaction
        .get("failed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let pending = transaction
        .get("pending")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let confirmations = json_u64_string(transaction, "confirmations")?;
    let block_height = json_u64_string(transaction, "blockHeight")?;
    if failed
        || pending
        || block_height == 0
        || confirmations < genesis.commit_maturity_blocks
        || confirmations > genesis.commit_reveal_window_blocks
    {
        return Err("The MFW claim is outside its finalized commit reveal window.".to_owned());
    }
    Ok(())
}
#[tauri::command]
async fn present_recovery_seed(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    mut input: PresentRecoverySeedInput,
) -> Result<bool, String> {
    require_app_unlocked(&protection)?;
    diagnostics::record(&app, "wallet.seed-presentation-started", &[]);
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Approve showing the recovery seed",
    )
    .await?;
    diagnostics::record(&app, "wallet.seed-presentation-authorized", &[]);

    let registry = wallet_registry::list(&app)?;
    let registration = registry
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == input.registration_id)
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    if registration.kind != "software"
        || registration.role.as_deref() == Some("fast")
        || registration.id.starts_with("fast-")
    {
        return Err(
            "Recovery seeds cannot be revealed for Fast, hardware, or watch-only wallets."
                .to_owned(),
        );
    }
    let native_wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&registration.id)
        .cloned()
        .ok_or_else(|| "Open this software wallet before backing it up.".to_owned())?;
    if native_wallet_id != input.wallet_id {
        return Err("The recovery-seed request does not match the open wallet.".to_owned());
    }

    let sync_was_deferred_for_seed_backup = registration.seed_backup_status == "pending";
    let seed = Zeroizing::new(
        state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .recovery_seed(&native_wallet_id)?,
    );
    let wallet_label = registration
        .display_name
        .as_deref()
        .unwrap_or(&registration.wallet_name);
    let confirmed = show_native_recovery_seed_backup(wallet_label, seed.as_str(), false);
    diagnostics::record(
        &app,
        if confirmed {
            "wallet.seed-backup-confirmed"
        } else {
            "wallet.seed-backup-deferred"
        },
        &[
            ("kind", "standard".to_owned()),
            ("boundary", "native".to_owned()),
        ],
    );
    if confirmed {
        wallet_registry::mark_seed_backed_up(&app, &registration.id)?;
        if sync_was_deferred_for_seed_backup {
            diagnostics::record(&app, "wallet.seed-backup-starting-sync", &[]);
            schedule_wallet_sync(app, native_wallet_id, registration.network);
        }
    }
    Ok(confirmed)
}
fn snapshot_for_account(
    wallet: &native_wallet::NativeWallet,
    wallet_id: &str,
    account_index: u32,
) -> Result<String, String> {
    let raw = wallet.snapshot(wallet_id)?;
    // A saved registration represents one Monero account.  The Core snapshot
    // deliberately aggregates every account in a wallet, which is useful for
    // an aggregate view but wrong for a standard Ledger registration when its
    // separate Fast Wallet lives in account 1.  Always replace the aggregate
    // amount/address with the selected account, including account 0.
    let mut snapshot: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "The native wallet snapshot was invalid.".to_owned())?;
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| "The native wallet snapshot was invalid.".to_owned())?;
    object.insert(
        "primaryAddress".to_owned(),
        serde_json::Value::String(wallet.address(wallet_id, account_index, 0)?),
    );
    object.insert(
        "balanceAtomic".to_owned(),
        serde_json::Value::String(wallet.balance(wallet_id, account_index, false)?),
    );
    object.insert(
        "unlockedBalanceAtomic".to_owned(),
        serde_json::Value::String(wallet.balance(wallet_id, account_index, true)?),
    );
    serde_json::to_string(&snapshot)
        .map_err(|_| "The native wallet snapshot could not be encoded.".to_owned())
}
#[tauri::command]
async fn wallet_snapshot(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let wallet = try_lock_native_wallet(&app, &state, "wallet-snapshot")?;
    match input.account_index {
        Some(account_index) => snapshot_for_account(
            &wallet,
            &input.wallet_id,
            checked_account_index(Some(account_index))?,
        ),
        // Omitting the account is intentional: the native snapshot is the
        // complete wallet-container total across all Monero accounts and all
        // of their subaddresses.
        None => wallet.snapshot(&input.wallet_id),
    }
}
#[tauri::command]
async fn registered_wallet_snapshots(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<RegisteredWalletSnapshot>, String> {
    require_app_unlocked(&protection)?;
    let registered = wallet_registry::list(&app)?;
    let session_ids = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .clone();
    let wallet = try_lock_native_wallet(&app, &state, "registered-wallet-snapshots")?;
    let companions = registered
        .wallets
        .iter()
        .filter(|registration| registration.kind == "view-only")
        .filter_map(|registration| {
            registration
                .source_wallet_id
                .as_deref()
                .map(|source_id| (source_id, registration))
        })
        .collect::<HashMap<_, _>>();

    // React Native exposes one Ledger registration whose read side is its
    // encrypted view-only companion.  Desktop stores that companion as an
    // internal registry row, so project its snapshot back onto the parent
    // Ledger ID.  The renderer then sees one wallet, one balance and one scan
    // status, and cannot accidentally double-count the internal cache.
    registered
        .wallets
        .iter()
        .filter(|registration| registration.kind != "view-only")
        .filter_map(|registration| {
            let snapshot_registration = if registration.kind == "hardware"
                && registration.role.as_deref().unwrap_or("standard") == "standard"
            {
                companions
                    .get(registration.id.as_str())
                    .copied()
                    .filter(|companion| session_ids.contains_key(&companion.id))
                    .unwrap_or(registration)
            } else {
                registration
            };
            session_ids
                .get(&snapshot_registration.id)
                .map(|session_id| (registration, snapshot_registration, session_id))
        })
        .map(|(registration, snapshot_registration, session_id)| {
            let legacy_account_scoped = registration.kind == "hardware"
                && (registration.role.as_deref() == Some("fast")
                    || registered.wallets.iter().any(|candidate| {
                        candidate.kind == "hardware"
                            && candidate.role.as_deref() == Some("fast")
                            && candidate.source_wallet_id.as_deref()
                                == Some(registration.id.as_str())
                    }));
            Ok(RegisteredWalletSnapshot {
                registration_id: registration.id.clone(),
                snapshot: if legacy_account_scoped {
                    // Preserve old Ledger account-pair registrations without
                    // counting account 1 both in the parent and Fast card.
                    snapshot_for_account(
                        &wallet,
                        session_id,
                        snapshot_registration.account_index.unwrap_or(0),
                    )?
                } else {
                    wallet.snapshot(session_id)?
                },
                uses_ledger_read_only: snapshot_registration.kind == "view-only",
            })
        })
        .collect()
}
#[tauri::command]
fn wallet_balance(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .balance(&input.wallet_id, account_index, false)
}
#[tauri::command]
fn wallet_unlocked_balance(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .balance(&input.wallet_id, account_index, true)
}
#[tauri::command]
fn create_subaddress(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: SubaddressInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .create_subaddress(&input.wallet_id, account_index, &input.label)
}
#[tauri::command]
fn list_subaddresses(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .list_subaddresses(&input.wallet_id, account_index)
}
#[tauri::command]
async fn wallet_transactions(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    let raw = try_lock_native_wallet(&app, &state, "wallet-transactions")?
        .transactions(&input.wallet_id)?;
    serialized_transactions_for_account(&raw, account_index)
}

/// The native Core history belongs to its physical wallet container and can
/// contain entries from account 0 and a Fast Wallet account 1. Every desktop
/// registration represents one logical account, so scope the history before
/// it crosses the Tauri boundary.
fn serialized_transactions_for_account(raw: &str, account_index: u32) -> Result<String, String> {
    let mut transactions: Vec<serde_json::Value> = serde_json::from_str(raw)
        .map_err(|_| "The native wallet transaction history was invalid.".to_owned())?;
    transactions.retain(|transaction| {
        transaction
            .get("subaddressAccount")
            .and_then(serde_json::Value::as_u64)
            == Some(u64::from(account_index))
    });
    serde_json::to_string(&transactions)
        .map_err(|_| "The native wallet transaction history could not be encoded.".to_owned())
}

/// Reads history through the same logical wallet registration shown in the
/// UI. For Ledger wallets this resolves to the encrypted read-only companion;
/// signing commands continue to use the hardware session.
#[tauri::command]
async fn registered_wallet_transactions(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    input: RegistrationIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let registry = wallet_registry::list(&app)?;
    let registration = registry
        .wallets
        .iter()
        .find(|wallet| wallet.id == input.registration_id)
        .cloned()
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    let read_registration = physical_registration_for_open(&app, &registration)?;
    let wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&read_registration.id)
        .cloned()
        .ok_or_else(|| "The wallet's local read session is not open yet.".to_owned())?;
    // A wallet registration represents the complete Monero wallet in the
    // main Activity and dashboard views. Return every account so outgoing
    // history cannot disappear merely because it belongs to another account.
    // Account-scoped address tools continue to use `wallet_transactions`.
    try_lock_native_wallet(&app, &state, "registered-wallet-transactions")?.transactions(&wallet_id)
}
#[tauri::command]
fn prepare_transaction(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    input: PrepareTransactionInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    let transaction_wallet_id = if let Some(registration_id) = input.registration_id.as_deref() {
        let registry = wallet_registry::list(&app)?;
        let registration = registry
            .wallets
            .iter()
            .find(|wallet| wallet.id == registration_id)
            .cloned()
            .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
        let current_read_session = wallet_session_id(&sessions, &registration.id)?
            .ok_or_else(|| "The selected wallet session is not open yet.".to_owned())?;
        if current_read_session != input.wallet_id {
            return Err(
                "The selected wallet session changed. Open it again before sending.".to_owned(),
            );
        }
        if registration.kind == "hardware"
            && registration.role.as_deref().unwrap_or("standard") == "standard"
        {
            if registration.ledger_key_images_verified_at.is_none() {
                return Err("Check spend outputs with Ledger before sending.".to_owned());
            }
            let snapshot_raw = try_lock_native_wallet(&app, &state, "ledger-send-readiness")?
                .snapshot(&current_read_session)?;
            let snapshot: serde_json::Value = serde_json::from_str(&snapshot_raw)
                .map_err(|_| "The Ledger wallet snapshot could not be verified.".to_owned())?;
            if snapshot
                .get("synchronized")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
                || snapshot
                    .get("pendingOutputKeyImageCount")
                    .and_then(|value| {
                        value
                            .as_u64()
                            .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
                    })
                    .unwrap_or(u64::MAX)
                    != 0
            {
                return Err(
                    "Check all pending spend outputs with Ledger before sending.".to_owned(),
                );
            }
            ensure_ledger_hardware_session(
                &app,
                &state,
                &sessions,
                &registration,
                "transaction-signing",
            )?
        } else {
            current_read_session
        }
    } else {
        input.wallet_id.clone()
    };
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_transaction(
            &transaction_wallet_id,
            &input.address,
            &input.amount_atomic,
            input.payment_id.as_deref().unwrap_or(""),
            input.priority.as_deref().unwrap_or("low"),
            account_index,
        )?;
    let prepared: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "The native transaction review was invalid.".to_owned())?;
    let pending_id = prepared
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The native transaction review has no pending ID.".to_owned())?;
    let amount_atomic = prepared
        .get("amountAtomic")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The native transaction review has no amount.".to_owned())?;
    let fee_atomic = prepared
        .get("feeAtomic")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The native transaction review has no fee.".to_owned())?;
    let mut pending = approvals
        .0
        .lock()
        .map_err(|_| "Transaction approval state is busy.".to_owned())?;
    let current_time = now();
    pending.retain(|_, approval| approval.expires_at > current_time);
    pending.insert(
        pending_id.to_owned(),
        PendingTransactionApproval {
            wallet_id: transaction_wallet_id,
            address: input.address,
            amount_atomic: amount_atomic.to_owned(),
            fee_atomic: fee_atomic.to_owned(),
            expires_at: current_time.saturating_add(120),
            mfw: None,
        },
    );
    Ok(raw)
}
#[tauri::command]
async fn commit_transaction(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    mut input: CommitTransactionInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Approve this Monero transaction",
    )
    .await?;
    let approval = approvals
        .0
        .lock()
        .map_err(|_| "Transaction approval state is busy.".to_owned())?
        .remove(&input.pending_id)
        .ok_or_else(|| {
            "This transaction review is missing, expired, or was already used.".to_owned()
        })?;
    let transaction_wallet_id = if let Some(registration_id) = input.registration_id.as_deref() {
        let registry = wallet_registry::list(&app)?;
        let registration = registry
            .wallets
            .iter()
            .find(|wallet| wallet.id == registration_id)
            .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
        let current_read_session = wallet_session_id(&sessions, &registration.id)?
            .ok_or_else(|| "The selected wallet session is not open yet.".to_owned())?;
        if current_read_session != input.wallet_id {
            return Err(
                "The selected wallet session changed. Prepare the transaction again.".to_owned(),
            );
        }
        if registration.kind == "hardware"
            && registration.role.as_deref().unwrap_or("standard") == "standard"
        {
            let signing_wallet_id =
                wallet_session_id(&sessions, &ledger_hardware_session_key(&registration.id))?
                    .ok_or_else(|| {
                        "Reconnect Ledger and prepare the transaction again.".to_owned()
                    })?;
            if approval.wallet_id != signing_wallet_id {
                return Err("The Ledger transaction review is no longer current.".to_owned());
            }
            signing_wallet_id
        } else {
            if approval.wallet_id != input.wallet_id {
                return Err("The transaction review belongs to a different wallet.".to_owned());
            }
            input.wallet_id.clone()
        }
    } else {
        if approval.wallet_id != input.wallet_id {
            return Err("The transaction review belongs to a different wallet.".to_owned());
        }
        input.wallet_id.clone()
    };
    if approval.expires_at <= now() {
        return Err("The transaction review expired. Prepare it again.".to_owned());
    }
    let operation = approval
        .mfw
        .as_ref()
        .map(|mfw| format!("\nMFW operation: {}", mfw.kind))
        .unwrap_or_default();
    let description = format!(
        "Recipient:\n{}\n\nAmount (atomic XMR): {}\nNetwork fee (atomic XMR): {}{}\n\nApprove this exact transaction?",
        approval.address, approval.amount_atomic, approval.fee_atomic, operation
    );
    let decision = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Final transaction approval")
        .set_description(description)
        .set_buttons(MessageButtons::YesNo)
        .show();
    if decision != MessageDialogResult::Yes {
        return Err("Transaction cancelled in the trusted native confirmation.".to_owned());
    }
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .commit_transaction(&transaction_wallet_id, &input.pending_id)?;
    if let Some(mfw) = approval.mfw {
        let committed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| "The native MFW broadcast result was invalid.".to_owned())?;
        if committed.get("status").and_then(serde_json::Value::as_str) != Some("ok") {
            return Err(committed
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("The MFW transaction could not be broadcast.")
                .to_owned());
        }
        let tx_ids = committed
            .get("txIds")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "The native MFW broadcast result has no transaction ID.".to_owned())?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "The native MFW transaction ID is invalid.".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let record = mfw_names::get(&app, &mfw.record_id)?;
        let updated = mfw_names::apply_broadcast(record, &mfw.kind, mfw.years, &tx_ids)?;
        mfw_names::upsert(&app, updated)?;
    }
    Ok(raw)
}
#[tauri::command]
fn wallet_hardware_status(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .hardware_status(&input.wallet_id)
}
#[tauri::command]
fn reconnect_hardware_wallet(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .reconnect_hardware(&input.wallet_id)
}
#[tauri::command]
fn show_hardware_wallet_address(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: HardwareAddressInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    let address_index = checked_account_index(input.address_index)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .show_hardware_address(&input.wallet_id, account_index, address_index)
}
#[tauri::command]
async fn community_load_profile(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
) -> Result<community::CommunityProfile, String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.load_profile().await
}
#[tauri::command]
async fn community_update_profile(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunityProfileUpdateInput,
) -> Result<community::CommunityProfile, String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.update_profile(input).await
}
#[tauri::command]
async fn community_list_nearby(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunityRadiusInput,
) -> Result<Vec<community::CommunityNearby>, String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.list_nearby(input.radius_km).await
}
#[tauri::command]
async fn community_list_contacts(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<community::CommunityContact>, String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.list_contacts().await
}
#[tauri::command]
async fn community_request_contact(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunityPeerInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.request_contact(&input.peer_id).await
}
#[tauri::command]
async fn community_accept_contact(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunityPeerInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.accept_contact(&input.peer_id).await
}
#[tauri::command]
async fn community_list_messages(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunityMessagesInput,
) -> Result<Vec<community::CommunityMessage>, String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.list_messages(&input.peer_id, input.after_ms).await
}
#[tauri::command]
async fn community_send_message(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunitySendMessageInput,
) -> Result<community::CommunityMessage, String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.send_message(&input.peer_id, &input.body).await
}
#[tauri::command]
async fn community_block_profile(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunityPeerInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.block_profile(&input.peer_id).await
}
#[tauri::command]
async fn community_report_profile(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
    input: community::CommunityReportInput,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.report_profile(&input.peer_id, &input.reason).await
}
#[tauri::command]
async fn community_delete_identity(
    state: State<'_, community::CommunityState>,
    protection: State<'_, AppProtectionState>,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    require_legacy_community_release()?;
    state.delete_identity().await
}

/// Public readiness only. The production implementation keeps Community
/// credentials, Matrix sessions, search vectors and signing trust anchors
/// below this command boundary.
#[tauri::command]
async fn enthusiast_v1_status(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<enthusiast_v1::CommunityV1Status, String> {
    require_app_unlocked(&protection)?;
    Ok(state.status(&app).await)
}

#[tauri::command]
fn enthusiast_v1_query_contribution_enabled(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<bool, String> {
    require_app_unlocked(&protection)?;
    community_preferences::share_search_terms(&app)
}

#[tauri::command]
fn enthusiast_v1_set_query_contribution_enabled(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    enabled: bool,
) -> Result<bool, String> {
    require_app_unlocked(&protection)?;
    community_preferences::set_share_search_terms(&app, enabled)
}

#[tauri::command]
async fn enthusiast_v1_contribute_query(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    query: String,
    language: String,
) -> Result<enthusiast_v1::CommunityQueryContributionResult, String> {
    require_app_unlocked(&protection)?;
    if !community_preferences::share_search_terms(&app)? {
        return Ok(enthusiast_v1::CommunityQueryContributionResult {
            accepted: false,
            duplicate: false,
            eligible_for_review: false,
            filtered: false,
        });
    }
    state.contribute_query(&app, &query, &language).await
}

#[tauri::command]
async fn enthusiast_v1_search(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    input: serde_json::Value,
) -> Result<Vec<enthusiast_v1::CommunityV1SearchResult>, String> {
    require_app_unlocked(&protection)?;
    state.search(&app, input).await
}

#[tauri::command]
async fn enthusiast_v1_suggestions(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    input: serde_json::Value,
) -> Result<Vec<enthusiast_v1::CommunityV1QuerySuggestion>, String> {
    require_app_unlocked(&protection)?;
    state.suggestions(&app, input).await
}

#[tauri::command]
fn enthusiast_v1_clear_search_history(
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state.clear_search_history()
}

#[tauri::command]
async fn enthusiast_v1_enable_notifications(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    locale: Option<String>,
) -> Result<serde_json::Value, String> {
    require_app_unlocked(&protection)?;
    if !cfg!(target_os = "macos") {
        return Err(
            "Community notifications currently require the APNs desktop provider on macOS."
                .to_owned(),
        );
    }
    desktop_notifications::request_installation(
        &app,
        desktop_notifications::RequestNotificationInstallationInput {
            permission_status: "authorized".to_owned(),
            locale,
            app_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            background_mode_enabled: Some(false),
        },
    )?;
    let polling_app = app.clone();
    let notification = tauri::async_runtime::spawn_blocking(move || {
        let mut latest = desktop_notifications::status(&polling_app)?;
        for _ in 0..40 {
            if latest.installation.provider == "apns"
                && latest.installation.provider_status == "ready"
                && !latest.installation.endpoint.is_empty()
            {
                return Ok(latest);
            }
            std::thread::sleep(Duration::from_millis(250));
            latest = desktop_notifications::status(&polling_app)?;
        }
        Ok::<_, String>(latest)
    })
    .await
    .map_err(|_| "Desktop notification registration stopped unexpectedly.".to_owned())??;
    if notification.installation.provider != "apns"
        || notification.installation.provider_status != "ready"
        || notification.installation.endpoint.is_empty()
    {
        return Err(
            "Notification permission was requested, but the APNs device token is not ready yet."
                .to_owned(),
        );
    }
    state
        .register_notification(
            &app,
            &notification.installation.installation_id,
            &notification.installation.provider,
            &notification.installation.endpoint,
        )
        .await
}

#[tauri::command]
async fn enthusiast_v1_initialize(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<enthusiast_v1::CommunityV1Status, String> {
    require_app_unlocked(&protection)?;
    state.initialize(&app).await
}

#[tauri::command]
async fn enthusiast_v1_start(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<enthusiast_v1::CommunityV1Status, String> {
    require_app_unlocked(&protection)?;
    state.start(&app).await?;
    Ok(state.status(&app).await)
}

#[tauri::command]
async fn enthusiast_v1_delete_identity(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state.delete_identity(&app).await
}

#[tauri::command]
async fn enthusiast_v1_account_status(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<enthusiast_v1::CommunityAccountStatus, String> {
    require_app_unlocked(&protection)?;
    state.account_status(&app).await
}

#[tauri::command]
async fn enthusiast_v1_chat_report_outcome(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    case_id: String,
) -> Result<enthusiast_v1::CommunityModerationOutcome, String> {
    require_app_unlocked(&protection)?;
    state.chat_report_outcome(&app, &case_id).await
}

#[tauri::command]
async fn enthusiast_v1_appeal_chat_report(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    case_id: String,
    reason: String,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state.appeal_chat_report(&app, &case_id, &reason).await
}

#[tauri::command]
async fn enthusiast_v1_content_moderation_outcomes(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<enthusiast_v1::CommunityContentModerationOutcome>, String> {
    require_app_unlocked(&protection)?;
    state.content_moderation_outcomes(&app).await
}

#[tauri::command]
async fn enthusiast_v1_appeal_content_moderation(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    case_id: String,
    reason: String,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state
        .appeal_content_moderation(&app, &case_id, &reason)
        .await
}

#[tauri::command]
async fn enthusiast_v1_submit_content(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    input: enthusiast_v1::CommunityContentDraft,
) -> Result<serde_json::Value, String> {
    require_app_unlocked(&protection)?;
    state.submit_content(&app, input).await
}

#[tauri::command]
async fn enthusiast_v1_resubmit_content(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    public_id: String,
    input: enthusiast_v1::CommunityContentDraft,
) -> Result<serde_json::Value, String> {
    require_app_unlocked(&protection)?;
    state.resubmit_content(&app, &public_id, input).await
}

#[tauri::command]
async fn enthusiast_v1_content_status(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    public_id: String,
) -> Result<serde_json::Value, String> {
    require_app_unlocked(&protection)?;
    state.content_status(&app, &public_id).await
}

#[tauri::command]
async fn enthusiast_v1_list_content(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<serde_json::Value>, String> {
    require_app_unlocked(&protection)?;
    state.list_content(&app).await
}

#[tauri::command]
async fn enthusiast_v1_request_contact(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    peer_id: String,
) -> Result<enthusiast_v1::CommunityContactRequest, String> {
    require_app_unlocked(&protection)?;
    state.request_contact(&app, &peer_id).await
}

#[tauri::command]
async fn enthusiast_v1_pending_contacts(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<enthusiast_v1::CommunityContactRequest>, String> {
    require_app_unlocked(&protection)?;
    state.pending_contacts(&app).await
}

#[tauri::command]
async fn enthusiast_v1_accepted_contacts(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<enthusiast_v1::CommunityChatDescriptor>, String> {
    require_app_unlocked(&protection)?;
    state.accepted_contacts(&app).await
}

#[tauri::command]
async fn enthusiast_v1_respond_contact(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    request_id: String,
    accept: bool,
) -> Result<Option<enthusiast_v1::CommunityContactRequest>, String> {
    require_app_unlocked(&protection)?;
    state.respond_contact(&app, &request_id, accept).await
}

#[tauri::command]
async fn enthusiast_v1_open_chat(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    peer_id: String,
) -> Result<enthusiast_v1::CommunityChatDescriptor, String> {
    require_app_unlocked(&protection)?;
    state.open_chat(&app, &peer_id).await
}

#[tauri::command]
async fn enthusiast_v1_messages(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    room_id: String,
    from: Option<String>,
    limit: usize,
) -> Result<community_matrix_core::MatrixMessagePage, String> {
    require_app_unlocked(&protection)?;
    state.messages(&app, &room_id, from.as_deref(), limit).await
}

#[tauri::command]
async fn enthusiast_v1_send_message(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    room_id: String,
    body: String,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    state.send_message(&app, &room_id, &body).await
}

#[tauri::command]
async fn enthusiast_v1_report_preview(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    room_id: String,
    event_id: String,
) -> Result<community_matrix_core::SelectedMessageReport, String> {
    require_app_unlocked(&protection)?;
    state.report_preview(&app, &room_id, &event_id).await
}

#[tauri::command]
async fn enthusiast_v1_report_message(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    peer_id: String,
    room_id: String,
    event_id: String,
    reason: String,
    illegal_content_notice: bool,
    confirmed_exact_message: bool,
) -> Result<enthusiast_v1::CommunityCaseReceipt, String> {
    require_app_unlocked(&protection)?;
    state
        .report_message(
            &app,
            &peer_id,
            &room_id,
            &event_id,
            &reason,
            illegal_content_notice,
            confirmed_exact_message,
        )
        .await
}

#[tauri::command]
async fn enthusiast_v1_block_contact(
    app: AppHandle,
    state: State<'_, enthusiast_v1::CommunityV1State>,
    protection: State<'_, AppProtectionState>,
    peer_id: String,
) -> Result<(), String> {
    require_app_unlocked(&protection)?;
    state.block_contact(&app, &peer_id).await
}

fn require_legacy_community_release() -> Result<(), String> {
    release_features::require(
        "legacyCommunity",
        "The legacy Community service is disabled in this release.",
    )
}
fn private_service_url(kind: &str, timeframe: Option<&str>) -> Result<String, String> {
    const BASE: &str = "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion";
    match (kind, timeframe) {
        ("news", None) => Ok(format!("{BASE}/news/v1/news?limit=10")),
        ("quote", None) => Ok(format!("{BASE}/api/v1/market/quote")),
        ("chart", Some(value)) if matches!(value, "24H" | "7D" | "1M" | "1Y" | "Max") => {
            Ok(format!("{BASE}/api/v1/market/chart?timeframe={value}"))
        }
        _ => Err("Unknown private service request.".to_owned()),
    }
}
fn network(value: &str) -> Result<u8, String> {
    match value {
        "mainnet" => Ok(0),
        "testnet" => Ok(1),
        "stagenet" => Ok(2),
        _ => Err("Unknown wallet network.".to_owned()),
    }
}
fn decode_bounded_hex(
    value: &str,
    minimum_bytes: usize,
    maximum_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0
        || value.len() < minimum_bytes.saturating_mul(2)
        || value.len() > maximum_bytes.saturating_mul(2)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} has an invalid encoding."));
    }
    hex::decode(value).map_err(|_| format!("{label} has an invalid encoding."))
}
fn wallet_path(app: &AppHandle, name: &str) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "Wallet name may contain only letters, numbers, hyphens, and underscores.".to_owned(),
        );
    };
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Wallet data directory is unavailable.".to_owned())?
        .join("wallets");
    fs::create_dir_all(&directory)
        .map_err(|_| "Wallet data directory could not be created.".to_owned())?;
    Ok(directory
        .join(format!("{name}.wallet"))
        .to_string_lossy()
        .into_owned())
}

fn remove_temporary_wallet_files(path: &str) {
    // The path was generated by wallet_path() for this command only. Ignore
    // cleanup failures: they cannot affect the persisted read-only wallet.
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(format!("{path}.keys"));
}

fn wallet_file_path_is_available(path: &str) -> bool {
    // Removing a wallet from the app intentionally keeps its encrypted files.
    // A future add must therefore skip both the cache and key-file names,
    // rather than asking the native Core to overwrite an existing wallet.
    !std::path::Path::new(path).exists() && !std::path::Path::new(&format!("{path}.keys")).exists()
}

fn next_wallet_file_name(app: &AppHandle, requested: &str, prefix: &str) -> Result<String, String> {
    let requested = requested.trim();
    let registry = wallet_registry::list(app)?;
    let used = registry
        .wallets
        .iter()
        .map(|wallet| wallet.wallet_name.as_str())
        .collect::<std::collections::HashSet<_>>();
    if !requested.is_empty() && !used.contains(requested) {
        let path = wallet_path(app, requested)?;
        if wallet_file_path_is_available(&path) {
            return Ok(requested.to_owned());
        }
    }
    let mut number = 1_u64;
    loop {
        let candidate = format!("{prefix}-{number}");
        let path = wallet_path(app, &candidate)?;
        if !used.contains(candidate.as_str()) && wallet_file_path_is_available(&path) {
            return Ok(candidate);
        }
        number += 1;
    }
}

fn checked_account_index(value: Option<u32>) -> Result<u32, String> {
    let value = value.unwrap_or(0);
    if value > 1_000_000 {
        return Err("The selected wallet account is invalid.".to_owned());
    }
    Ok(value)
}

/// Mobile creates a device-protected credential by default. Desktop mirrors
/// that behavior with a high-entropy local wallet-file password held only in
/// the OS keychain; it is never returned to the React renderer.
fn wallet_password_or_generated(input: &mut String) -> Result<String, String> {
    let mut password = std::mem::take(input);
    if !password.trim().is_empty() {
        return Ok(password);
    }
    password.zeroize();
    let mut entropy = [0_u8; 32];
    getrandom::getrandom(&mut entropy)
        .map_err(|_| "A secure local wallet credential could not be generated.".to_owned())?;
    let password = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    entropy.zeroize();
    Ok(password)
}

fn finish_wallet_operation_with_password(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    wallet_id: String,
    wallet: wallet_registry::RegisteredWallet,
    password: String,
    schedule_sync: bool,
) -> Result<WalletOperationResponse, String> {
    let registration_id = wallet.id.clone();
    if let Err(error) = secure_store::store_wallet_password(&registration_id, password) {
        diagnostics::record(
            app,
            "wallet.credential-store-failed",
            &[
                ("kind", wallet.kind.clone()),
                ("reason", "secure-store".to_owned()),
            ],
        );
        // A wallet without its device-held credential would not meet the
        // passwordless setup promise. Close the native wallet before it is
        // persisted or exposed as an unlocked session.
        let _ = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .close(&wallet_id, false);
        return Err(error);
    }
    diagnostics::record(
        app,
        "wallet.credential-stored",
        &[
            ("kind", wallet.kind.clone()),
            ("verified", "true".to_owned()),
        ],
    );
    match finish_wallet_operation(app, state, sessions, wallet_id, wallet, schedule_sync) {
        Ok(response) => Ok(response),
        Err(error) => {
            let _ = secure_store::delete_wallet_password(&registration_id);
            Err(error)
        }
    }
}

/// Persist and warm an internal wallet session without changing the wallet
/// selected by the user.  Ledger read-only companions are the desktop
/// equivalent of React Native's `viewOnlyPath`: they provide balance and
/// transaction discovery, but must never appear as or activate a second
/// wallet in the UI.
fn finish_internal_wallet_operation_with_password(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    wallet_id: String,
    wallet: wallet_registry::RegisteredWallet,
    password: String,
    schedule_sync: bool,
) -> Result<WalletOperationResponse, String> {
    let registration_id = wallet.id.clone();
    if let Err(error) = secure_store::store_wallet_password(&registration_id, password) {
        let _ = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .close(&wallet_id, false);
        return Err(error);
    }
    let wallet = match wallet_registry::upsert_inactive(app, wallet) {
        Ok(wallet) => wallet,
        Err(error) => {
            let _ = secure_store::delete_wallet_password(&registration_id);
            let _ = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&wallet_id, false);
            return Err(error);
        }
    };
    sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .insert(wallet.id.clone(), wallet_id.clone());
    if schedule_sync {
        schedule_wallet_sync(app.clone(), wallet_id.clone(), wallet.network.clone());
    }
    diagnostics::record(
        app,
        "wallet.internal-companion-opened",
        &[("kind", wallet.kind.clone())],
    );
    Ok(WalletOperationResponse { wallet_id, wallet })
}

fn registration_for_open(
    app: &AppHandle,
    wallet_name: &str,
    wallet_network: &str,
    restore_height: Option<u64>,
) -> Result<wallet_registry::RegisteredWallet, String> {
    if let Some(mut wallet) = wallet_registry::list(app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.wallet_name == wallet_name && wallet.network == wallet_network)
    {
        // A user-selected scan date must update the durable registration
        // before the native open call. Otherwise the Core would silently use
        // the previous height even though the setup UI accepted a new date.
        if let Some(height) = restore_height {
            wallet.restore_height = Some(height);
        }
        return Ok(wallet);
    }
    Ok(wallet_registry::software_wallet(
        wallet_name,
        wallet_network,
        restore_height,
        "unchanged",
    ))
}

fn physical_registration_for_open(
    app: &AppHandle,
    registration: &wallet_registry::RegisteredWallet,
) -> Result<wallet_registry::RegisteredWallet, String> {
    if registration.kind != "hardware" {
        return Ok(registration.clone());
    }
    let registry = wallet_registry::list(app)?;
    let source_wallet_id = if registration.role.as_deref() == Some("fast") {
        registration.source_wallet_id.as_deref().ok_or_else(|| {
            "The linked Ledger wallet is missing. Remove this Fast Wallet and add the Ledger again."
                .to_owned()
        })?
    } else {
        registration.id.as_str()
    };

    // Match React Native's Ledger lifecycle: after the one-time, explicit
    // view-key export, every read/open/sync operation uses the encrypted local
    // view-only companion. The physical Ledger is opened again only for an
    // operation that needs signing or key-image approval.
    if let Some(companion) = registry.wallets.iter().find(|wallet| {
        wallet.kind == "view-only" && wallet.source_wallet_id.as_deref() == Some(source_wallet_id)
    }) {
        return Ok(companion.clone());
    }

    registry
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == source_wallet_id)
        .ok_or_else(|| {
            "The linked Ledger wallet is missing. Remove this Fast Wallet and add the Ledger again."
                .to_owned()
        })
}

fn first_party_endpoint_with_dns_fallback(endpoint: &str) -> (String, bool) {
    let Some(port) = endpoint.strip_prefix("xmr.tex8.com:") else {
        return (endpoint.to_owned(), false);
    };
    if endpoint
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .is_some()
    {
        return (endpoint.to_owned(), false);
    }
    (format!("152.53.133.188:{port}"), true)
}

/// Node discovery and Monero's daemon `init()` can wait for an operating-system
/// DNS or TCP timeout. Never keep the create/open IPC call (and therefore the
/// setup screen) blocked by that network work. The wallet is already safely
/// registered and open at this point; connection state is reported separately
/// through snapshots and privacy-safe diagnostics.
fn schedule_wallet_sync(app: AppHandle, wallet_id: String, network_name: String) {
    let scheduled = app.state::<WalletSyncState>();
    let newly_scheduled = match scheduled.0.lock() {
        Ok(mut wallet_ids) => wallet_ids.insert(wallet_id.clone()),
        Err(_) => {
            diagnostics::record(
                &app,
                "wallet.sync-queue-failed",
                &[("reason", "state-busy".to_owned())],
            );
            return;
        }
    };
    if !newly_scheduled {
        diagnostics::record(
            &app,
            "wallet.sync-already-queued",
            &[("network", network_name)],
        );
        return;
    }
    diagnostics::record(
        &app,
        "wallet.sync-queued",
        &[("network", network_name.clone())],
    );
    // Only one native configuration may touch the serialized Core at once.
    // Do not drop other registered wallets merely because the owner switches
    // the visible card. They are consumers of the same public chain feed and
    // must make bounded background progress after the app-wide unlock.
    let should_start = match app.state::<NodeSyncState>().0.lock() {
        Ok(mut queue) => {
            if queue.active {
                if !queue
                    .pending
                    .iter()
                    .any(|(queued_wallet_id, _)| queued_wallet_id == &wallet_id)
                {
                    queue
                        .pending
                        .push_back((wallet_id.clone(), network_name.clone()));
                }
                diagnostics::record(
                    &app,
                    "wallet.sync-queued-behind-active-network-work",
                    &[("network", network_name.clone())],
                );
                false
            } else {
                queue.active = true;
                true
            }
        }
        Err(_) => {
            if let Ok(mut scheduled) = app.state::<WalletSyncState>().0.lock() {
                scheduled.remove(&wallet_id);
            }
            diagnostics::record(
                &app,
                "wallet.sync-queue-failed",
                &[("reason", "node-state-busy".to_owned())],
            );
            false
        }
    };
    if !should_start {
        return;
    }
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let mut permit = WalletSyncPermit {
            app: app.clone(),
            wallet_id: wallet_id.clone(),
            retain: false,
        };
        let _node_sync_permit = NodeSyncPermit { app: app.clone() };
        let total_started = Instant::now();
        // Let the renderer paint the already-open wallet before Core starts
        // its potentially slow daemon handshake.  The handshake runs in the
        // background, but Core serializes wallet calls while `init()` is in
        // progress; starting it in the same turn used to make the first
        // dashboard snapshot look like a seven-second open operation.
        std::thread::sleep(Duration::from_millis(750));
        diagnostics::record(
            &app,
            "wallet.sync-worker-started",
            &[("network", network_name.clone())],
        );
        let profile = match node_settings::load(&app, &network_name) {
            Ok(profile) => profile,
            Err(_) => {
                diagnostics::record(
                    &app,
                    "wallet.node-profile-load-failed",
                    &[("network", network_name)],
                );
                return;
            }
        };
        // Wallet-operation hostnames must never reach the operating-system
        // resolver. Only the Clearnet gRPC block route may use DNS fallback.
        let daemon_address = profile.daemon_address.clone();
        let (grpc_endpoint, grpc_dns_fallback) =
            first_party_endpoint_with_dns_fallback(&profile.grpc_endpoint);
        if grpc_dns_fallback {
            diagnostics::record(
                &app,
                "wallet.node-dns-fallback",
                &[
                    ("network", profile.network.clone()),
                    ("grpcFallback", grpc_dns_fallback.to_string()),
                ],
            );
        }
        let mut node_password = if profile.password_stored {
            match secure_store::load_node_daemon_password(&profile.network) {
                Ok(password) => password.unwrap_or_default(),
                Err(_) => {
                    diagnostics::record(
                        &app,
                        "wallet.node-credential-load-failed",
                        &[("network", profile.network.clone())],
                    );
                    return;
                }
            }
        } else {
            String::new()
        };

        let daemon_started = Instant::now();
        diagnostics::record(
            &app,
            "wallet.node-configuration-started",
            &[
                ("network", profile.network.clone()),
                ("nodeMode", profile.mode.clone()),
            ],
        );
        let state = app.state::<NativeWalletState>();
        let configure_result =
            lock_native_wallet(&app, &state, "node-configuration").and_then(|native| {
                native.set_daemon(native_wallet::DaemonConfig {
                    wallet_id: &wallet_id,
                    address: &daemon_address,
                    trusted: profile.trusted,
                    use_ssl: profile.use_ssl,
                    username: &profile.username,
                    password: &node_password,
                    proxy_address: &profile.proxy_address,
                })
            });
        node_password.zeroize();
        if configure_result.is_err() {
            diagnostics::record(
                &app,
                "wallet.node-configuration-failed",
                &[
                    ("network", profile.network.clone()),
                    ("reason", "native-error".to_owned()),
                    (
                        "elapsedMs",
                        daemon_started.elapsed().as_millis().to_string(),
                    ),
                ],
            );
            return;
        }
        diagnostics::record(
            &app,
            "wallet.node-configured",
            &[
                ("network", profile.network.clone()),
                (
                    "elapsedMs",
                    daemon_started.elapsed().as_millis().to_string(),
                ),
            ],
        );

        if profile.mode != "original-rpc" && !grpc_endpoint.is_empty() {
            let grpc_started = Instant::now();
            let grpc_result = lock_native_wallet(&app, &state, "grpc-configuration")
                .and_then(|native| native.set_grpc_endpoint(&wallet_id, &grpc_endpoint));
            diagnostics::record(
                &app,
                if grpc_result.is_ok() {
                    "wallet.grpc-configured"
                } else {
                    "wallet.grpc-configuration-failed"
                },
                &[
                    ("network", profile.network.clone()),
                    ("elapsedMs", grpc_started.elapsed().as_millis().to_string()),
                ],
            );
            // gRPC streaming is an optional Core extension.  A release that
            // uses the normal Wallet API must still refresh via its configured
            // daemon when that optional endpoint is unavailable.
            if grpc_result.is_err() {
                diagnostics::record(
                    &app,
                    "wallet.grpc-fallback-to-rpc",
                    &[("network", profile.network.clone())],
                );
            }
        }

        let refresh_started = Instant::now();
        let refresh_result = lock_native_wallet(&app, &state, "refresh-start")
            .and_then(|native| native.start_refresh(&wallet_id));
        if let Err(error) = refresh_result {
            eprintln!(
                "MONERO_DESKTOP_WALLET_SYNC refresh-start-failed network={} error={error}",
                profile.network
            );
            diagnostics::record(
                &app,
                "wallet.refresh-start-failed",
                &[
                    ("network", profile.network.clone()),
                    ("reason", "native-error".to_owned()),
                    (
                        "elapsedMs",
                        refresh_started.elapsed().as_millis().to_string(),
                    ),
                ],
            );
            return;
        }
        diagnostics::record(
            &app,
            "wallet.sync-started",
            &[
                ("network", profile.network),
                ("nodeMode", profile.mode),
                ("usesTls", profile.use_ssl.to_string()),
                (
                    "refreshStartMs",
                    refresh_started.elapsed().as_millis().to_string(),
                ),
                ("elapsedMs", total_started.elapsed().as_millis().to_string()),
            ],
        );
        // Keep this native wallet marked as initialized for the remainder of
        // the process. Activating an already-open wallet must never enqueue a
        // second daemon handshake behind the global Monero Core lock.
        permit.retain = true;
    });
}

/// Clears a failed synchronization reservation automatically so a later
/// activation can retry. Successful sessions retain the reservation and are
/// activated entirely in memory.
struct WalletSyncPermit {
    app: AppHandle,
    wallet_id: String,
    retain: bool,
}

/// Releases the single Core configuration slot and starts the next registered
/// wallet without dropping earlier work. This is deliberately independent of
/// the per-wallet initialized set managed by `WalletSyncPermit`.
struct NodeSyncPermit {
    app: AppHandle,
}

impl Drop for NodeSyncPermit {
    fn drop(&mut self) {
        let pending = self
            .app
            .state::<NodeSyncState>()
            .0
            .lock()
            .ok()
            .and_then(|mut queue| {
                queue.active = false;
                queue.pending.pop_front()
            });
        if let Some((wallet_id, network_name)) = pending {
            // The request was reserved before the previous configuration
            // completed. Let the scheduler claim it anew now that the global
            // slot is available.
            if let Ok(mut scheduled) = self.app.state::<WalletSyncState>().0.lock() {
                scheduled.remove(&wallet_id);
            }
            schedule_wallet_sync(self.app.clone(), wallet_id, network_name);
        }
    }
}

impl Drop for WalletSyncPermit {
    fn drop(&mut self) {
        if self.retain {
            return;
        }
        if let Ok(mut wallet_ids) = self.app.state::<WalletSyncState>().0.lock() {
            wallet_ids.remove(&self.wallet_id);
        }
    }
}

fn finish_wallet_operation(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    wallet_id: String,
    wallet: wallet_registry::RegisteredWallet,
    schedule_sync: bool,
) -> Result<WalletOperationResponse, String> {
    let wallet = match wallet_registry::upsert(app, wallet) {
        Ok(wallet) => wallet,
        Err(error) => {
            // Do not leave a usable unlocked session when durable metadata was
            // not saved. The wallet file itself is never deleted here.
            let _ = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&wallet_id, false);
            return Err(error);
        }
    };
    sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .insert(wallet.id.clone(), wallet_id.clone());
    diagnostics::record(
        app,
        "wallet.opened",
        &[
            ("network", wallet.network.clone()),
            ("kind", wallet.kind.clone()),
            (
                "restoreHeightConfigured",
                wallet.restore_height.is_some().to_string(),
            ),
        ],
    );

    // A newly created software wallet must show its recovery words before
    // *any* node work starts. `Wallet::init()` can take many seconds and holds
    // the native engine lock; scheduling it here previously made the required
    // seed dialog appear late or look as if it had disappeared. This mirrors
    // the mobile flow: a pending backup is the deliberate synchronization
    // boundary, not a best-effort reminder.
    if wallet.kind == "software" && wallet.seed_backup_status == "pending" {
        diagnostics::record(
            app,
            "wallet.sync-deferred",
            &[("reason", "seed-backup-required".to_owned())],
        );
    } else if schedule_sync {
        schedule_wallet_sync(app.clone(), wallet_id.clone(), wallet.network.clone());
    } else {
        diagnostics::record(
            app,
            "wallet.sync-deferred",
            &[("reason", "wallet-preloaded".to_owned())],
        );
    }
    Ok(WalletOperationResponse { wallet_id, wallet })
}

pub fn run() {
    // Arti and Matrix currently bring different rustls providers into the
    // desktop binary. Rustls deliberately refuses to guess in that case, so
    // select one before any plugin, HTTP client, or Tor runtime can use TLS.
    // This is process-wide and keeps the embedded Tor bootstrap deterministic.
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_ok()
    {
        eprintln!("MONERO_DESKTOP_TLS provider=ring");
    }
    // This must remain the first plugin. A second launch focuses the existing
    // wallet window and exits before it can initialize Keychain, native wallet,
    // or biometric state a second time.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            eprintln!("MONERO_DESKTOP_SINGLE_INSTANCE second-launch=focused-existing");
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());
    let builder = if desktop_updates_enabled() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .manage(NativeWalletState(Mutex::new(
            native_wallet::NativeWallet::new().expect("native wallet core initialization"),
        )))
        .manage(WalletSessionState(Mutex::new(HashMap::new())))
        .manage(WalletSessionRecoveryState::new())
        .manage(WalletSyncState(Mutex::new(HashSet::new())))
        .manage(NodeSyncState(Mutex::new(NodeSyncQueue::default())))
        .manage(WalletWarmState(Mutex::new(false)))
        .manage(FastWalletSessionState(Mutex::new(HashMap::new())))
        .manage(FastWalletMaintenanceState(Mutex::new(false)))
        .manage(LedgerViewKeyExportState(Mutex::new(HashSet::new())))
        .manage(PendingTransactionApprovalState(Mutex::new(HashMap::new())))
        // Always enter fail-closed. The renderer's single explicit protection
        // status request performs the first credential-store read only after
        // the single-instance plugin has rejected any duplicate process.
        .manage(AppProtectionState(Mutex::new(true)))
        .manage(AppSessionSecurityState(Mutex::new(AppSessionSecurity {
            last_user_activity: Instant::now(),
            auto_lock_seconds: security_settings::DEFAULT_AUTO_LOCK_SECONDS,
        })))
        .manage(
            enthusiast_v1::CommunityV1State::new()
                .expect("Monero Enthusiast native client initialization"),
        )
        .manage(community::CommunityState::new().expect("Community client initialization"))
        .setup(|app| {
            // Tor initializes on its own runtime. Bootstrapping must never
            // delay the first desktop frame or opening a saved wallet.
            tor_transport::start_embedded_tor(
                app.path()
                    .app_data_dir()
                    .map_err(|error| format!("App data directory is unavailable: {error}"))?
                    .join("embedded-tor"),
            );
            start_desktop_connectivity_monitor(app.handle().clone());
            app_vault::initialize(app.handle())?;
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| "The main wallet window is unavailable.".to_owned())?;
            // Apply the non-secret compute preference before any wallet can be
            // opened or synchronized. A damaged preference file fails safely
            // to CPU-only for this process and is reported in diagnostics.
            let compute_preference = match compute_preferences::load(app.handle()) {
                Ok(preference) => preference,
                Err(error) => {
                    eprintln!("MONERO_DESKTOP_COMPUTE preference-load-failed error={error}");
                    "cpu".to_owned()
                }
            };
            {
                let native_state = app.state::<NativeWalletState>();
                let native = native_state
                    .0
                    .lock()
                    .map_err(|_| "Native wallet is busy.".to_owned())?;
                native.set_compute_backend(&compute_preference)?;
            }
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                main_window
                    .set_content_protected(false)
                    .map_err(|error| format!("Screen-capture policy failed: {error}"))?;
                eprintln!("MONERO_DESKTOP_SCREEN_CAPTURE protected=false");
            }

            let security_app = app.handle().clone();
            let configured_timeout = security_settings::load(&security_app)?.auto_lock_seconds;
            {
                let session = security_app.state::<AppSessionSecurityState>();
                let mut current = session
                    .0
                    .lock()
                    .map_err(|_| "App session security state is busy.".to_owned())?;
                current.auto_lock_seconds = configured_timeout;
                current.last_user_activity = Instant::now();
            }
            diagnostics::record(
                &security_app,
                "security.auto-lock-monitor-started",
                &[("autoLockSeconds", configured_timeout.to_string())],
            );
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                if secure_store::diagnostic_automation_unlock_enabled() {
                    continue;
                }
                let protection = security_app.state::<AppProtectionState>();
                if app_is_locked(&protection).unwrap_or(true) {
                    continue;
                }
                if secure_store::load_app_protection_mode()
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("none")
                {
                    continue;
                }
                let timed_out = security_app
                    .state::<AppSessionSecurityState>()
                    .0
                    .lock()
                    .map(|session| {
                        session.auto_lock_seconds > 0
                            && session.last_user_activity.elapsed()
                                >= Duration::from_secs(session.auto_lock_seconds)
                    })
                    .unwrap_or(false);
                if !timed_out {
                    continue;
                }
                diagnostics::record(&security_app, "security.auto-lock-triggered", &[]);
                let state = security_app.state::<NativeWalletState>();
                let sessions = security_app.state::<WalletSessionState>();
                let fast_sessions = security_app.state::<FastWalletSessionState>();
                let approvals = security_app.state::<PendingTransactionApprovalState>();
                let community_v1 = security_app.state::<enthusiast_v1::CommunityV1State>();
                if let Err(error) = lock_app_native(
                    &state,
                    &sessions,
                    &fast_sessions,
                    &approvals,
                    &protection,
                    &community_v1,
                ) {
                    eprintln!("MONERO_DESKTOP_APP_PROTECTION inactivity-lock-failed: {error}");
                } else {
                    let _ = security_app.emit("app-lock-state-changed", true);
                }
            });
            if std::env::var("MONERO_DESKTOP_TEST_NOTIFICATION_ON_START").as_deref() == Ok("1") {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    match app_handle
                        .notification()
                        .builder()
                        .title("Monero Fast Wallet")
                        .body("Private notifications are enabled.")
                        .show()
                    {
                        Ok(()) => eprintln!("monero desktop test notification sent"),
                        Err(error) => eprintln!("monero desktop test notification failed: {error}"),
                    }
                });
            }
            if std::env::var("MONERO_DESKTOP_TEST_APNS_ON_START").as_deref() == Ok("1") {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let request = desktop_notifications::RequestNotificationInstallationInput {
                        permission_status: "authorized".to_owned(),
                        locale: Some("de-DE".to_owned()),
                        app_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                        background_mode_enabled: Some(false),
                    };
                    match desktop_notifications::request_installation(&app_handle, request) {
                        Ok(status) => eprintln!(
                            "monero desktop apns registration requested: delivery={} providerStatus={}",
                            status.delivery, status.installation.provider_status
                        ),
                        Err(error) => eprintln!("monero desktop apns registration request failed: {error}"),
                    }
                    std::thread::sleep(Duration::from_secs(8));
                    match desktop_notifications::status(&app_handle) {
                        Ok(status) => eprintln!(
                            "monero desktop apns status: delivery={} providerStatus={} endpointLength={}",
                            status.delivery,
                            status.installation.provider_status,
                            status.installation.endpoint.len()
                        ),
                        Err(error) => eprintln!("monero desktop apns status failed: {error}"),
                    }
                });
            }
            if std::env::var("MONERO_DESKTOP_TEST_BACKGROUND_AGENT_ON_START").as_deref() == Ok("1") {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let request = desktop_notifications::RequestNotificationInstallationInput {
                        permission_status: "authorized".to_owned(),
                        locale: Some("en-US".to_owned()),
                        app_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                        background_mode_enabled: Some(true),
                    };
                    match desktop_notifications::request_installation(&app_handle, request) {
                        Ok(status) => {
                            // This opt-in marker makes background-agent setup
                            // observable from Windows or Linux without storing
                            // endpoint or wallet data in diagnostics.
                            diagnostics::record(
                                &app_handle,
                                "notifications.background-agent-test-result",
                                &[
                                    ("delivery", status.delivery.clone()),
                                    ("providerStatus", status.installation.provider_status.clone()),
                                    ("endpointPresent", (!status.installation.endpoint.is_empty()).to_string()),
                                ],
                            );
                            eprintln!(
                                "monero desktop background-agent requested: delivery={} providerStatus={}",
                                status.delivery,
                                status.installation.provider_status,
                            );
                        }
                        Err(error) => {
                            diagnostics::record(
                                &app_handle,
                                "notifications.background-agent-test-result",
                                &[("outcome", "error".to_owned())],
                            );
                            eprintln!("monero desktop background-agent setup failed: {error}");
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            wallet_core_status,
            compute_backend_status,
            set_compute_backend,
            derivation_performance,
            diagnostic_derivation_performance,
            diagnostic_secure_storage_roundtrip,
            diagnostic_fast_wallet_integrity,
            diagnostic_fast_wallet_worker,
            app_protection_status,
            retry_app_protection_status,
            set_app_protection_password,
            verify_app_protection_password,
            set_app_protection_mode,
            verify_system_auth,
            lock_app,
            record_app_user_activity,
            auto_lock_settings,
            set_auto_lock_timeout,
            fetch_private_service,
            wallet_ui_diagnostic,
            ledger_transport_status,
            store_wallet_password,
            delete_wallet_password,
            create_wallet,
            restore_wallet_with_native_seed,
            restore_fast_wallet_with_native_seed,
            create_hardware_wallet,
            enable_ledger_read_only,
            create_ledger_read_only_from_device,
            reconcile_ledger_balance,
            wallet_open_requires_password,
            open_wallet,
            close_wallet,
            rename_wallet,
            remove_registered_wallet,
            list_registered_wallets,
            activate_registered_wallet,
            recover_registered_wallet_session,
            queue_registered_wallet_sync,
            list_fast_wallets,
            open_fast_wallet,
            close_fast_wallet,
            remove_fast_wallet,
            remove_fast_wallet_entry,
            present_fast_wallet_recovery_seed,
            create_fast_wallet,
            pair_private_fast_wallet_worker,
            list_community_fast_wallet_workers,
            select_community_fast_wallet_worker,
            enable_encrypted_fast_wallet_alerts,
            turn_off_fast_wallet_alerts,
            delete_hosted_fast_wallet_data,
            enable_fast_wallet,
            enable_ledger_fast_wallet,
            refresh_fast_wallet_status,
            notification_installation_status,
            request_notification_installation,
            disable_notification_installation,
            consume_pending_notification_open,
            background_notification_agent_config_path,
            disable_fast_wallet,
            load_node_settings,
            save_node_settings,
            connectivity_status,
            diagnose_connection_routes,
            set_daemon,
            network_sync_status,
            start_wallet_refresh,
            stop_wallet_refresh,
            wallet_address,
            validate_recipient_address,
            verify_mfw_name_record_address,
            list_mfw_names,
            resolve_mfw_name_for_payment,
            check_mfw_name_availability,
            prepare_mfw_name_registration,
            prepare_mfw_name_claim,
            prepare_mfw_name_transition,
            export_mfw_name_recovery,
            import_mfw_name_recovery,
            refresh_mfw_name,
            remove_mfw_name_local,
            present_recovery_seed,
            wallet_snapshot,
            registered_wallet_snapshots,
            wallet_balance,
            wallet_unlocked_balance,
            create_subaddress,
            list_subaddresses,
            wallet_transactions,
            registered_wallet_transactions,
            prepare_transaction,
            commit_transaction,
            wallet_hardware_status,
            reconnect_hardware_wallet,
            show_hardware_wallet_address,
            community_load_profile,
            community_update_profile,
            community_list_nearby,
            community_list_contacts,
            community_request_contact,
            community_accept_contact,
            community_list_messages,
            community_send_message,
            community_block_profile,
            community_report_profile,
            community_delete_identity,
            enthusiast_v1_status,
            enthusiast_v1_query_contribution_enabled,
            enthusiast_v1_set_query_contribution_enabled,
            enthusiast_v1_contribute_query,
            enthusiast_v1_search,
            enthusiast_v1_suggestions,
            enthusiast_v1_clear_search_history,
            enthusiast_v1_enable_notifications,
            enthusiast_v1_initialize,
            enthusiast_v1_start,
            enthusiast_v1_delete_identity,
            enthusiast_v1_account_status,
            enthusiast_v1_chat_report_outcome,
            enthusiast_v1_appeal_chat_report,
            enthusiast_v1_content_moderation_outcomes,
            enthusiast_v1_appeal_content_moderation,
            enthusiast_v1_submit_content,
            enthusiast_v1_resubmit_content,
            enthusiast_v1_content_status,
            enthusiast_v1_list_content,
            enthusiast_v1_request_contact,
            enthusiast_v1_pending_contacts,
            enthusiast_v1_accepted_contacts,
            enthusiast_v1_respond_contact,
            enthusiast_v1_open_chat,
            enthusiast_v1_messages,
            enthusiast_v1_send_message,
            enthusiast_v1_report_preview,
            enthusiast_v1_report_message,
            enthusiast_v1_block_contact,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monero Fast Wallet desktop");
}

fn desktop_updates_enabled() -> bool {
    serde_json::from_str::<serde_json::Value>(include_str!("../../../../config/app-update.json"))
        .ok()
        .and_then(|config| config["desktop"]["enabled"].as_bool())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        bind_ledger_session_ids, ledger_hardware_session_key, mark_connectivity_checking,
        require_app_unlocked, serialized_transactions_for_account,
        shared_native_session_for_physical_registration, validate_fast_wallet_removal_snapshot,
        wallet_file_path_is_available, wallet_session_id, AppProtectionState,
        ConnectivityRouteState, WalletSessionRecoveryClaim, WalletSessionRecoveryState,
        WalletSessionState,
    };
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn connectivity_recheck_preserves_last_confirmed_route() {
        let routes = Mutex::new(HashMap::from([(
            "mainnet".to_owned(),
            ConnectivityRouteState {
                phase: "connected".to_owned(),
                connected: true,
                endpoint: "route.example:18091".to_owned(),
                checked_at_ms: 42,
                elapsed_ms: Some(7),
                error: None,
            },
        )]));

        mark_connectivity_checking(&routes, "mainnet", "route.example:18091");
        let retained = routes.lock().unwrap()["mainnet"].clone();
        assert!(retained.connected);
        assert_eq!(retained.phase, "connected");
        assert_eq!(retained.checked_at_ms, 42);

        mark_connectivity_checking(&routes, "mainnet", "replacement.example:18091");
        let changed = routes.lock().unwrap()["mainnet"].clone();
        assert!(!changed.connected);
        assert_eq!(changed.phase, "checking");
        assert_eq!(changed.endpoint, "replacement.example:18091");
    }

    #[test]
    fn parallel_stale_polls_share_exactly_one_reopen_attempt() {
        let recovery = Arc::new(WalletSessionRecoveryState::new());
        let key = "physical-container";
        let leader_attempt = match recovery.claim_after_stale(key, 0).unwrap() {
            WalletSessionRecoveryClaim::Leader { attempt } => attempt,
            WalletSessionRecoveryClaim::Completed { .. } => panic!("first claim must lead"),
        };
        assert_eq!(leader_attempt, 1);

        let followers = (0..8)
            .map(|_| {
                let recovery = Arc::clone(&recovery);
                std::thread::spawn(move || recovery.claim_after_stale(key, 0).unwrap())
            })
            .collect::<Vec<_>>();
        recovery.finish(key, leader_attempt, Ok(1)).unwrap();

        for follower in followers {
            match follower.join().unwrap() {
                WalletSessionRecoveryClaim::Completed { attempt, outcome } => {
                    assert_eq!(attempt, 1);
                    assert_eq!(outcome.unwrap(), 1);
                }
                WalletSessionRecoveryClaim::Leader { .. } => {
                    panic!("a parallel stale poll started a duplicate reopen")
                }
            }
        }
        assert_eq!(recovery.observed_attempt(key).unwrap(), 1);
    }

    #[test]
    fn a_completed_reopen_wins_over_an_older_stale_observation() {
        let recovery = WalletSessionRecoveryState::new();
        let key = "physical-container";
        let attempt = match recovery.claim_after_stale(key, 0).unwrap() {
            WalletSessionRecoveryClaim::Leader { attempt } => attempt,
            WalletSessionRecoveryClaim::Completed { .. } => panic!("first claim must lead"),
        };
        recovery.finish(key, attempt, Ok(1)).unwrap();

        match recovery.claim_after_stale(key, 0).unwrap() {
            WalletSessionRecoveryClaim::Completed { attempt, outcome } => {
                assert_eq!(attempt, 1);
                assert_eq!(outcome.unwrap(), 1);
            }
            WalletSessionRecoveryClaim::Leader { .. } => {
                panic!("an old stale read must not trigger a sequential duplicate")
            }
        }
    }

    #[test]
    fn wallet_session_lookup_releases_the_mutex_before_nested_session_work() {
        let sessions = WalletSessionState(Mutex::new(HashMap::from([(
            "ledger-view".to_owned(),
            "native-view".to_owned(),
        )])));

        assert_eq!(
            wallet_session_id(&sessions, "ledger-view").unwrap(),
            Some("native-view".to_owned())
        );
        assert!(sessions.0.try_lock().is_ok());
    }

    #[test]
    fn transaction_history_is_scoped_to_the_logical_wallet_account() {
        let raw = r#"[
          {"hash":"standard-entry","subaddressAccount":0},
          {"hash":"fast-entry-one","subaddressAccount":1},
          {"hash":"fast-entry-two","subaddressAccount":1}
        ]"#;

        let filtered = serialized_transactions_for_account(raw, 1).unwrap();
        let entries: Vec<serde_json::Value> = serde_json::from_str(&filtered).unwrap();

        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry["subaddressAccount"] == 1));
    }

    #[test]
    fn ledger_accounts_share_one_native_container_in_both_open_orders() {
        let standard = crate::wallet_registry::hardware_wallet(
            "ledger-1",
            "mainnet",
            Some(3_500_000),
            Some(0),
            Some("standard"),
            None,
        );
        let fast = crate::wallet_registry::hardware_wallet(
            "ledger-fast-1",
            "mainnet",
            Some(3_500_000),
            Some(1),
            Some("fast"),
            Some(&standard.id),
        );
        let registry = crate::wallet_registry::WalletRegistry {
            version: 1,
            active_wallet_id: Some(standard.id.clone()),
            wallets: vec![standard.clone(), fast.clone()],
        };

        let fast_first = HashMap::from([(fast.id.clone(), "native-ledger".to_owned())]);
        assert_eq!(
            shared_native_session_for_physical_registration(&registry, &fast_first, &standard.id,)
                .as_deref(),
            Some("native-ledger")
        );

        let standard_first = HashMap::from([(standard.id.clone(), "native-ledger".to_owned())]);
        assert_eq!(
            shared_native_session_for_physical_registration(
                &registry,
                &standard_first,
                &standard.id,
            )
            .as_deref(),
            Some("native-ledger")
        );
    }

    #[test]
    fn ledger_logical_entries_reuse_the_local_view_only_session() {
        let standard = crate::wallet_registry::hardware_wallet(
            "ledger-1",
            "mainnet",
            Some(3_500_000),
            Some(0),
            Some("standard"),
            None,
        );
        let fast = crate::wallet_registry::hardware_wallet(
            "ledger-fast-1",
            "mainnet",
            Some(3_500_000),
            Some(1),
            Some("fast"),
            Some(&standard.id),
        );
        let companion = crate::wallet_registry::ledger_read_only_wallet(
            "ledger-read-1",
            "mainnet",
            Some(3_500_000),
            &standard.id,
        );
        let registry = crate::wallet_registry::WalletRegistry {
            version: 1,
            active_wallet_id: Some(standard.id.clone()),
            wallets: vec![standard, fast, companion.clone()],
        };
        let sessions = HashMap::from([(companion.id.clone(), "native-view-only".to_owned())]);

        assert_eq!(
            shared_native_session_for_physical_registration(&registry, &sessions, &companion.id,)
                .as_deref(),
            Some("native-view-only")
        );
    }

    #[test]
    fn ledger_read_session_preserves_signing_handle_until_key_images_are_imported() {
        let standard = crate::wallet_registry::hardware_wallet(
            "ledger-1",
            "mainnet",
            Some(3_500_000),
            Some(0),
            Some("standard"),
            None,
        );
        let fast = crate::wallet_registry::hardware_wallet(
            "ledger-fast-1",
            "mainnet",
            Some(3_500_000),
            Some(1),
            Some("fast"),
            Some(&standard.id),
        );
        let companion = crate::wallet_registry::ledger_read_only_wallet(
            "ledger-read-1",
            "mainnet",
            Some(3_500_000),
            &standard.id,
        );
        let registry = crate::wallet_registry::WalletRegistry {
            version: 1,
            active_wallet_id: Some(standard.id.clone()),
            wallets: vec![standard.clone(), fast.clone(), companion.clone()],
        };
        let mut sessions = HashMap::from([(standard.id.clone(), "native-ledger".to_owned())]);

        bind_ledger_session_ids(
            &mut sessions,
            &registry,
            &standard,
            &companion,
            "native-view-only",
            Some("native-ledger"),
            true,
        );

        assert_eq!(
            sessions.get(&standard.id).map(String::as_str),
            Some("native-view-only")
        );
        assert_eq!(
            sessions.get(&fast.id).map(String::as_str),
            Some("native-view-only")
        );
        assert_eq!(
            sessions.get(&companion.id).map(String::as_str),
            Some("native-view-only")
        );
        assert_eq!(
            sessions
                .get(&ledger_hardware_session_key(&standard.id))
                .map(String::as_str),
            Some("native-ledger")
        );

        bind_ledger_session_ids(
            &mut sessions,
            &registry,
            &standard,
            &companion,
            "native-view-only",
            Some("native-ledger"),
            false,
        );
        assert!(!sessions.contains_key(&ledger_hardware_session_key(&standard.id)));
        assert!(!sessions.values().any(|session| session == "native-ledger"));
    }

    #[test]
    fn native_authorization_fails_closed_while_the_app_is_locked() {
        let locked = AppProtectionState(Mutex::new(true));
        assert!(require_app_unlocked(&locked).is_err());

        let unlocked = AppProtectionState(Mutex::new(false));
        assert!(require_app_unlocked(&unlocked).is_ok());
    }

    #[test]
    fn wallet_filename_availability_reserves_existing_wallet_and_key_files() {
        let directory = std::env::temp_dir().join(format!(
            "monero-fast-wallet-filename-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("ledger-1.wallet");
        let path = path.to_string_lossy().into_owned();

        assert!(wallet_file_path_is_available(&path));
        fs::write(format!("{path}.keys"), "test").unwrap();
        assert!(!wallet_file_path_is_available(&path));
        fs::remove_file(format!("{path}.keys")).unwrap();
        fs::write(&path, "test").unwrap();
        assert!(!wallet_file_path_is_available(&path));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn fast_wallet_removal_requires_a_synchronized_zero_balance() {
        assert!(validate_fast_wallet_removal_snapshot(
            r#"{"synchronized":true,"balanceAtomic":"0"}"#,
        )
        .is_ok());
        assert!(validate_fast_wallet_removal_snapshot(
            r#"{"synchronized":false,"balanceAtomic":"0"}"#,
        )
        .unwrap_err()
        .contains("synchronization"));
        assert!(validate_fast_wallet_removal_snapshot(
            r#"{"synchronized":true,"balanceAtomic":"1"}"#,
        )
        .unwrap_err()
        .contains("still contains Monero"));
        assert!(validate_fast_wallet_removal_snapshot(
            r#"{"synchronized":true,"balanceAtomic":"unknown"}"#,
        )
        .unwrap_err()
        .contains("unknown"));
    }
}
