mod community;
mod community_preferences;
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
mod wallet_core;
mod wallet_registry;
mod windows_notification_agent;

use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WalletCoreStatus {
    linked: bool,
    release_ready: bool,
    backend: &'static str,
    message: &'static str,
}

struct NativeWalletState(Mutex<native_wallet::NativeWallet>);
/// Native wallet IDs are intentionally process-local. Only this in-memory map
/// associates a persisted, non-secret registration with its open native session.
struct WalletSessionState(Mutex<HashMap<String, String>>);
/// Fast Wallet sessions are isolated from the active normal-wallet mapping.
/// Their renderer IDs are process-local and never identify a wallet file.
struct FastWalletSessionState(Mutex<HashMap<String, String>>);
/// A Ledger request can block while the user approves it on-device. Keep an
/// explicit per-Ledger in-flight marker so repeated renderer clicks never
/// create parallel sessions or repeated Export view key prompts.
struct LedgerViewKeyExportState(Mutex<HashSet<String>>);
/// `true` means the app is locked.  This is intentionally process-local: the
/// durable secret stays in Keychain/Credential Manager/libsecret, while every
/// native wallet session is closed on lock.
struct AppProtectionState(Mutex<bool>);
/// Monotonic focus generation used by the native 15-second background lock.
/// A focus regain invalidates every pending lock worker.
struct WindowSecurityState(Mutex<u64>);
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
    wallet_chain_height: Option<u64>,
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
    proxy_address: Option<String>,
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
fn notification_installation_status(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    require_app_unlocked(&protection)?;
    desktop_notifications::status(&app)
}

#[tauri::command]
fn request_notification_installation(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
    input: desktop_notifications::RequestNotificationInstallationInput,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    require_app_unlocked(&protection)?;
    desktop_notifications::request_installation(&app, input)
}

#[tauri::command]
fn disable_notification_installation(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    require_app_unlocked(&protection)?;
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
    }
}

#[tauri::command]
async fn fetch_market_backup(input: MarketBackupInput) -> Result<String, String> {
    let url = market_backup_url(&input.kind, input.timeframe.as_deref())?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Monero-Fast-Wallet-Desktop/0.1")
        .build()
        .map_err(|_| "Market backup client could not be initialized.".to_owned())?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "Backup market source could not be reached.".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "Backup market source returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    response
        .text()
        .await
        .map_err(|_| "Backup market source returned an invalid response.".to_owned())
}

#[tauri::command]
fn ledger_transport_status(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .ledger_transport_status()
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
            let delay = (1_u64 << next_failures.saturating_sub(1).min(8)).min(300);
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
    protection: &AppProtectionState,
) -> Result<AppProtectionStatus, String> {
    let mode = secure_store::load_app_protection_mode()?;
    let configured = mode.is_some();
    Ok(AppProtectionStatus {
        configured,
        locked: !configured || app_is_locked(protection)?,
        mode,
        password_configured: secure_store::app_protection_password_configured()?,
        system_auth: platform_auth::status().await,
    })
}

async fn require_fresh_app_authorization(
    app: AppHandle,
    password: &mut String,
    reason: &str,
) -> Result<(), String> {
    match secure_store::load_app_protection_mode()?.as_deref() {
        Some("password") => require_fresh_app_password(password),
        Some("system") => {
            if platform_auth::status().await.requires_recovery_password && !password.is_empty() {
                return require_fresh_app_password(password);
            }
            password.zeroize();
            platform_auth::authenticate(app, reason).await
        }
        _ => {
            password.zeroize();
            Err("App protection is not configured on this device.".to_owned())
        }
    }
}

#[tauri::command]
async fn app_protection_status(
    protection: State<'_, AppProtectionState>,
) -> Result<AppProtectionStatus, String> {
    app_protection_snapshot(&protection).await
}

#[tauri::command]
async fn set_app_protection_password(
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
    secure_store::store_app_protection_password(std::mem::take(&mut input.password))?;
    secure_store::store_app_protection_mode("password")?;
    secure_store::clear_app_unlock_throttle()?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    eprintln!("MONERO_DESKTOP_APP_PROTECTION configured");
    app_protection_snapshot(&protection).await
}

#[tauri::command]
async fn verify_app_protection_password(
    protection: State<'_, AppProtectionState>,
    mut input: AppProtectionPasswordInput,
) -> Result<AppProtectionStatus, String> {
    if !secure_store::app_protection_configured()? {
        input.password.zeroize();
        return Err("App protection is not configured on this device.".to_owned());
    }
    if secure_store::load_app_protection_mode()?.as_deref() == Some("system")
        && !platform_auth::status().await.requires_recovery_password
    {
        input.password.zeroize();
        return Err("Use the secure system sign-in configured for this app.".to_owned());
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
    input.password.zeroize();
    if !matches {
        let next_failures = failures.saturating_add(1);
        let delay = (1_u64 << next_failures.saturating_sub(1).min(8)).min(300);
        secure_store::store_app_unlock_throttle(next_failures, current_time.saturating_add(delay))?;
        eprintln!("MONERO_DESKTOP_APP_PROTECTION unlock-rejected");
        return Err(format!(
            "The app password is incorrect. Retry in {delay} seconds."
        ));
    }
    secure_store::clear_app_unlock_throttle()?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    eprintln!("MONERO_DESKTOP_APP_PROTECTION unlocked");
    app_protection_snapshot(&protection).await
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
            secure_store::store_app_protection_password(std::mem::take(&mut input.password))?;
            secure_store::store_app_protection_mode("password")?;
        }
        "system" => {
            let system = platform_auth::status().await;
            if !system.available {
                input.password.zeroize();
                return Err(system.detail);
            }
            if system.requires_recovery_password && input.password.chars().count() < 12 {
                input.password.zeroize();
                return Err(
                    "Linux fingerprint protection also needs a recovery app password with at least 12 characters."
                        .to_owned(),
                );
            }
            if current_mode.as_deref() != Some("system") {
                if let Err(error) = platform_auth::authenticate(
                    app,
                    "Confirm system sign-in for Monero Fast Wallet",
                )
                .await
                {
                    input.password.zeroize();
                    return Err(error);
                }
            }
            if system.requires_recovery_password {
                secure_store::store_app_protection_password(std::mem::take(&mut input.password))?;
            } else {
                input.password.zeroize();
            }
            secure_store::store_app_protection_mode("system")?;
        }
        _ => {
            input.password.zeroize();
            return Err("Choose app password or secure system sign-in.".to_owned());
        }
    }
    secure_store::clear_app_unlock_throttle()?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    eprintln!("MONERO_DESKTOP_APP_PROTECTION mode={}", input.mode);
    app_protection_snapshot(&protection).await
}

#[tauri::command]
async fn verify_system_auth(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<AppProtectionStatus, String> {
    if secure_store::load_app_protection_mode()?.as_deref() != Some("system") {
        return Err("Secure system sign-in is not configured for this app.".to_owned());
    }
    platform_auth::authenticate(app, "Unlock Monero Fast Wallet").await?;
    *protection
        .0
        .lock()
        .map_err(|_| "App protection state is busy.".to_owned())? = false;
    eprintln!("MONERO_DESKTOP_APP_PROTECTION system-unlocked");
    app_protection_snapshot(&protection).await
}

fn lock_app_native(
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    fast_sessions: &FastWalletSessionState,
    approvals: &PendingTransactionApprovalState,
    protection: &AppProtectionState,
    community_v1: &enthusiast_v1::CommunityV1State,
) -> Result<(), String> {
    if !secure_store::app_protection_configured()? {
        return Err("Set an app password before using Monero Fast Wallet.".to_owned());
    }
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
    secure_store::clear_session_secret_cache()?;
    eprintln!("MONERO_DESKTOP_APP_PROTECTION locked");
    if let Some(error) = close_error {
        return Err(format!(
            "Monero Fast Wallet is locked, but a wallet session reported: {error}"
        ));
    }
    Ok(())
}

#[tauri::command]
fn lock_app(
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    fast_sessions: State<'_, FastWalletSessionState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    community_v1: State<'_, enthusiast_v1::CommunityV1State>,
) -> Result<(), String> {
    lock_app_native(
        &state,
        &sessions,
        &fast_sessions,
        &approvals,
        &protection,
        &community_v1,
    )
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
    let wallet_name = next_wallet_file_name(&app, &input.wallet_name, "wallet")?;
    let wallet_network = input.network.clone();
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
            return Err(error);
        }
    };
    finish_wallet_operation_with_password(
        &app,
        &state,
        &sessions,
        wallet_id,
        wallet_registry::software_wallet(&wallet_name, &wallet_network, None, "pending"),
        password,
    )
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
    Ok(FastWalletOpenResponse {
        wallet_id,
        wallet: record,
    })
}
#[tauri::command]
fn create_hardware_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    mut input: CreateHardwareWalletInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let account_index = input.account_index.unwrap_or(0);
    let role = input.role.as_deref().unwrap_or("standard");
    if role != "standard" || account_index != 0 || input.create_fast.unwrap_or(false) {
        return Err(
            "Ledger Fast Wallet is disabled. Create only the normal Ledger wallet; an independent software Fast Wallet can be added later."
                .to_owned(),
        );
    }
    let native_account_index = account_index;
    let wallet_name = next_wallet_file_name(&app, &input.wallet_name, "ledger")?;
    let wallet_network = input.network.clone();
    let restore_height = input.restore_height.filter(|height| *height > 0);
    let path = wallet_path(&app, &wallet_name)?;
    let mut password = wallet_password_or_generated(&mut input.password)?;
    // Diagnostic only: no address, path, credential, or key material is ever
    // written. This makes an accidental duplicate Ledger initialization clear
    // in the Tauri development log.
    eprintln!(
        "MONERO_DESKTOP_LEDGER_CREATE start role={role} account={native_account_index} transport={} companionFast=false",
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
            restore_height: input.restore_height.unwrap_or(0),
            subaddress_lookahead: input.subaddress_lookahead.as_deref().unwrap_or(""),
            account_index: native_account_index,
        });
    let wallet_id = match result {
        Ok(wallet_id) => {
            eprintln!(
                "MONERO_DESKTOP_LEDGER_CREATE success role={role} account={native_account_index} companionFast=false"
            );
            wallet_id
        }
        Err(error) => {
            eprintln!(
                "MONERO_DESKTOP_LEDGER_CREATE failed role={role} account={native_account_index} error={error}"
            );
            password.zeroize();
            return Err(error);
        }
    };
    let registration = wallet_registry::hardware_wallet(
        &wallet_name,
        &wallet_network,
        restore_height,
        (account_index != 0).then_some(account_index),
        (role != "standard").then_some(role),
        None,
    );
    let response = finish_wallet_operation_with_password(
        &app,
        &state,
        &sessions,
        wallet_id,
        registration,
        password,
    )?;
    Ok(response)
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
    let active_native_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&source.id)
        .cloned()
        .ok_or_else(|| {
            "Open and unlock the Ledger wallet first, then approve Export view key on the Ledger."
                .to_owned()
        })?;
    if active_native_id != input.source_wallet_id {
        return Err(
            "The selected Ledger session changed. Open the Ledger wallet again and retry."
                .to_owned(),
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
    result
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
    match finish_wallet_operation_with_password(
        app,
        state,
        sessions,
        native_wallet_id,
        registration,
        local_password,
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
    let available = secure_store::load_wallet_password(&credential_registration.id)?.is_some();
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
fn open_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    mut input: OpenWalletInput,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let wallet_name = input.wallet_name.clone();
    let wallet_network = input.network.clone();
    let restore_height = input.restore_height.filter(|height| *height > 0);
    let registration = registration_for_open(&app, &wallet_name, &wallet_network, restore_height)?;
    let physical_registration = physical_registration_for_open(&app, &registration)?;
    // A Ledger Fast Wallet is account 1 in the exact same native wallet as
    // its standard Ledger parent. Reuse that live Core session when possible:
    // opening the Fast entry must not reconnect the Ledger, create another
    // wallet instance, or trigger another device approval.
    if registration.role.as_deref() == Some("fast") && registration.id != physical_registration.id {
        if let Some(existing_session_id) = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?
            .get(&physical_registration.id)
            .cloned()
        {
            sessions
                .0
                .lock()
                .map_err(|_| "Wallet session state is busy.".to_owned())?
                .insert(registration.id.clone(), existing_session_id.clone());
            let wallet = wallet_registry::upsert(&app, registration)?;
            diagnostics::record(
                &app,
                "ledger.fast-wallet-session-reused",
                &[("account", "1".to_owned())],
            );
            eprintln!("MONERO_DESKTOP_LEDGER_FAST reused-open-session account=1");
            return Ok(WalletOperationResponse {
                wallet_id: existing_session_id,
                wallet,
            });
        }
    }
    let path = wallet_path(&app, &physical_registration.wallet_name)?;
    // Wallet file credentials are generated by this app and live only in the
    // platform secure store. The renderer must never supply or retain an
    // individual wallet password after setup; discard any stale legacy field
    // rather than turning it into a second unlock boundary.
    let mut supplied_password = std::mem::take(&mut input.password);
    supplied_password.zeroize();
    let mut password;
    let is_hardware = registration.kind == "hardware";
    let uses_device_credential = is_hardware || registration.kind == "view-only";
    if uses_device_credential {
        // This is deliberately not a user password prompt.  Hardware wallet
        // files are assigned a random local credential at creation and only
        // the OS secure store may retrieve it.  The following Ledger
        // reconnect supplies the actual user authorization.
        password = secure_store::load_wallet_password(&physical_registration.id)?.ok_or_else(|| {
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
        password = secure_store::load_wallet_password(&physical_registration.id)?.ok_or_else(|| {
            "This wallet's device-protected unlock data is unavailable on this device. A wallet password will not fix this; restore the wallet from its recovery seed to create a new protected local copy.".to_owned()
        })?;
    }
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .open(
            &path,
            &password,
            network(&input.network)?,
            input.restore_height.unwrap_or(0),
        );
    let wallet_id = match result {
        Ok(wallet_id) => wallet_id,
        Err(error) => {
            password.zeroize();
            return Err(error);
        }
    };
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
    finish_wallet_operation_with_password(
        &app,
        &state,
        &sessions,
        wallet_id,
        registration,
        password,
    )
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
    for removed_id in &removed_ids {
        let session_id = sessions
            .0
            .lock()
            .map_err(|_| "Wallet session state is busy.".to_owned())?
            .remove(removed_id);
        if let Some(session_id) = session_id {
            if let Err(error) = state
                .0
                .lock()
                .map_err(|_| "Native wallet is busy.".to_owned())?
                .close(&session_id, true)
            {
                sessions
                    .0
                    .lock()
                    .map_err(|_| "Wallet session state is busy.".to_owned())?
                    .insert(removed_id.clone(), session_id);
                return Err(error);
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
    sessions: State<'_, WalletSessionState>,
    protection: State<'_, AppProtectionState>,
    wallet_id: String,
) -> Result<WalletOperationResponse, String> {
    require_app_unlocked(&protection)?;
    let registered = wallet_registry::list(&app)?;
    let wallet = registered
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == wallet_id)
        .ok_or_else(|| "Saved wallet was not found.".to_owned())?;
    let session_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&wallet.id)
        .cloned()
        .ok_or_else(|| "Open this wallet with its password first.".to_owned())?;
    let wallet = wallet_registry::upsert(&app, wallet)?;
    Ok(WalletOperationResponse {
        wallet_id: session_id,
        wallet,
    })
}
#[tauri::command]
fn list_fast_wallets(
    app: AppHandle,
    protection: State<'_, AppProtectionState>,
) -> Result<Vec<fast_wallet::FastWalletRecord>, String> {
    require_app_unlocked(&protection)?;
    fast_wallet::list(&app)
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
    // Fast Wallets are opened through a separate native session and therefore
    // must restore the same node profile explicitly before refresh begins.
    let profile = node_settings::load(&app, &wallet.network)?;
    let mut node_password = if profile.password_stored {
        secure_store::load_node_daemon_password(&profile.network)?.unwrap_or_default()
    } else {
        String::new()
    };
    let configured = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .set_daemon(native_wallet::DaemonConfig {
            wallet_id: &wallet_id,
            address: &profile.daemon_address,
            trusted: profile.trusted,
            use_ssl: profile.use_ssl,
            username: &profile.username,
            password: &node_password,
            proxy_address: &profile.proxy_address,
        });
    node_password.zeroize();
    if let Err(error) = configured {
        diagnostics::record(
            &app,
            "fast-wallet.node-configuration-failed",
            &[
                ("network", wallet.network.clone()),
                ("reason", "native-error".to_owned()),
            ],
        );
        return Err(format!(
            "Fast Wallet opened, but the node could not be configured: {error}"
        ));
    }
    if let Err(error) = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .start_refresh(&wallet_id)
    {
        diagnostics::record(
            &app,
            "fast-wallet.refresh-start-failed",
            &[
                ("network", wallet.network.clone()),
                ("reason", "native-error".to_owned()),
            ],
        );
        return Err(format!(
            "Fast Wallet opened, but refresh could not start: {error}"
        ));
    }
    diagnostics::record(
        &app,
        "fast-wallet.sync-started",
        &[
            ("network", wallet.network.clone()),
            ("nodeMode", profile.mode),
        ],
    );
    sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .insert(wallet.id.clone(), wallet_id.clone());
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
    if record.seed_backup_status != "verified" {
        return Err(
            "Back up this Fast Wallet's recovery words before removing it from the device."
                .to_owned(),
        );
    }
    if record.assignment_handle.is_some()
        || fast_wallet_enrollment::load_assignment(&record.id)?.is_some()
    {
        return Err(
            "Delete this Fast Wallet's hosted scan data before removing the local wallet."
                .to_owned(),
        );
    }
    let wallet_id = sessions
        .0
        .lock()
        .map_err(|_| "Fast Wallet session state is busy.".to_owned())?
        .get(&record.id)
        .cloned()
        .ok_or_else(|| "Open and synchronize this Fast Wallet before removing it.".to_owned())?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .snapshot(&wallet_id)?;
    validate_fast_wallet_removal_snapshot(&raw)?;
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
    Ok(())
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
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Approve showing the Fast Wallet recovery seed",
    )
    .await?;

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

    let mut seed = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .recovery_seed(&native_wallet_id)?;
    let result = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Fast Wallet recovery words")
        .set_description(&seed)
        .set_buttons(MessageButtons::OkCancel)
        .show();
    seed.zeroize();
    let confirmed = matches!(result, MessageDialogResult::Ok | MessageDialogResult::Yes);
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
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    fast_wallet::require_independent_software(&record)?;
    if record.seed_backup_status != "verified" {
        input.app_password.zeroize();
        return Err("Back up this Fast Wallet before turning payment alerts on.".to_owned());
    }
    match input.worker.as_str() {
        "official" => release_features::require(
            "officialWorker",
            "The recommended payment-alert service is disabled in this signed app.",
        )?,
        "private" => release_features::require(
            "privateWorkerPairing",
            "Private scan-service pairing is disabled in this signed app.",
        )?,
        _ => {
            input.app_password.zeroize();
            return Err("Choose the recommended or your paired private scan service.".to_owned());
        }
    }
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Turn on private incoming-payment alerts for this Fast Wallet",
    )
    .await?;

    desktop_notifications::request_installation(
        &app,
        desktop_notifications::RequestNotificationInstallationInput {
            permission_status: "authorized".to_owned(),
            locale: None,
            app_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            background_mode_enabled: Some(true),
        },
    )?;
    record.alert_status = "setting-up".to_owned();
    record.notifications_enabled = false;
    record = fast_wallet::update(&app, record)?;

    let result = async {
        let current_time = now();
        let worker = if input.worker == "official" {
            fast_wallet_enrollment::official_worker(&record.network, current_time).await?
        } else {
            fast_wallet_enrollment::load_private_worker(&record.network, current_time)?
        };
        let assignment =
            fast_wallet_enrollment::sponsor_assignment(&app, &record.id, &worker, current_time)
                .await?;
        let mut password =
            secure_store::load_fast_wallet_password(&record.id)?.ok_or_else(|| {
                "The protected Fast Wallet credential is unavailable on this device.".to_owned()
            })?;
        let path = fast_wallet::wallet_path(&app, &record.id)?;
        let envelope = state
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
        let envelope = envelope?;
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
            fast_wallet::update(&app, record)
        }
        Err(error) => {
            record.alert_status = "needs-attention".to_owned();
            record.notifications_enabled = false;
            let _ = fast_wallet::update(&app, record);
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
        "Ledger Fast Wallet is disabled in the safe V1 release.",
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
        let mut password = if profile.password_stored {
            secure_store::load_node_daemon_password(&profile.network)?.unwrap_or_default()
        } else {
            String::new()
        };
        let applied = state
            .0
            .lock()
            .map_err(|_| "Native wallet is busy.".to_owned())?
            .set_daemon(native_wallet::DaemonConfig {
                wallet_id: &wallet_id,
                address: &profile.daemon_address,
                trusted: profile.trusted,
                use_ssl: profile.use_ssl,
                username: &profile.username,
                password: &password,
                proxy_address: &profile.proxy_address,
            });
        password.zeroize();
        applied?;
    }
    Ok(profile)
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
            proxy_address: input.proxy_address.as_deref().unwrap_or(""),
        });
    input.password.zeroize();
    result
}
#[tauri::command]
fn start_wallet_refresh(
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
    let record = decode_bounded_hex(&input.record_payload_hex, 189, 251, "MFW record")?;
    let signing_owner = decode_bounded_hex(
        &input.signing_owner_public_key_hex,
        32,
        32,
        "MFW signing owner key",
    )?;
    let mut address = [0_u8; fast_wallet_protocol::ffi::MFW_MONERO_ADDRESS_BYTES];
    let status = unsafe {
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
    mfw_name_resolver::availability(&input.name, &input.network, input.wallet_chain_height)
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
    let wallet_height = json_u64_string(&snapshot, "walletHeight")?;
    let availability =
        mfw_name_resolver::availability(&canonical_name, &input.network, Some(wallet_height))?;
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
    let wallet_address = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .address(&input.wallet_id, account_index, address_index)?;
    if wallet_address != input.address.trim() {
        return Err(
            "The selected MFW receive address does not belong to the selected wallet index."
                .to_owned(),
        );
    }
    let address = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .validate_recipient_address(input.address.trim(), network_code)?;
    let mut raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_mfw_name_registration(
            &input.wallet_id,
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
            &input.wallet_id,
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
        || record.recovery_exported_at.is_none()
    {
        return Err(
            "This MFW name is not ready to reveal, or its recovery file was not exported."
                .to_owned(),
        );
    }
    let genesis = release_features::mfw_name_genesis(&record.network)
        .ok_or_else(|| "MFW genesis parameters are not configured for this network.".to_owned())?;
    require_mfw_commit_window(&state, &input.wallet_id, &record, &genesis)?;
    let mut owner = load_mfw_owner_state(&record)?;
    let network_code = network(&record.network)?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_mfw_name_claim(
            &input.wallet_id,
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
        &input.wallet_id,
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
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_mfw_name_transition(
            &input.wallet_id,
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
        &input.wallet_id,
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
    require_fresh_app_authorization(
        app.clone(),
        &mut input.app_password,
        "Approve showing the recovery seed",
    )
    .await?;

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

    let mut seed = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .recovery_seed(&native_wallet_id)?;
    let result = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("Offline recovery-seed backup")
        .set_description(&seed)
        .set_buttons(MessageButtons::OkCancel)
        .show();
    seed.zeroize();
    let confirmed = matches!(result, MessageDialogResult::Ok | MessageDialogResult::Yes);
    if confirmed {
        wallet_registry::mark_seed_backed_up(&app, &registration.id)?;
    }
    Ok(confirmed)
}
fn snapshot_for_account(
    wallet: &native_wallet::NativeWallet,
    wallet_id: &str,
    account_index: u32,
) -> Result<String, String> {
    let raw = wallet.snapshot(wallet_id)?;
    if account_index == 0 {
        return Ok(raw);
    }
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
fn wallet_snapshot(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    let wallet = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?;
    snapshot_for_account(&wallet, &input.wallet_id, account_index)
}
#[tauri::command]
fn registered_wallet_snapshots(
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
    let wallet = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?;
    registered
        .wallets
        .into_iter()
        .filter_map(|registration| {
            session_ids
                .get(&registration.id)
                .map(|session_id| (registration, session_id))
        })
        .map(|(registration, session_id)| {
            Ok(RegisteredWalletSnapshot {
                registration_id: registration.id,
                snapshot: snapshot_for_account(
                    &wallet,
                    session_id,
                    registration.account_index.unwrap_or(0),
                )?,
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
fn wallet_transactions(
    state: State<'_, NativeWalletState>,
    protection: State<'_, AppProtectionState>,
    input: WalletIdInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .transactions(&input.wallet_id)?;
    if account_index == 0 {
        return Ok(raw);
    }
    let mut transactions: Vec<serde_json::Value> = serde_json::from_str(&raw)
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
#[tauri::command]
fn prepare_transaction(
    state: State<'_, NativeWalletState>,
    approvals: State<'_, PendingTransactionApprovalState>,
    protection: State<'_, AppProtectionState>,
    input: PrepareTransactionInput,
) -> Result<String, String> {
    require_app_unlocked(&protection)?;
    let account_index = checked_account_index(input.account_index)?;
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .prepare_transaction(
            &input.wallet_id,
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
            wallet_id: input.wallet_id,
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
    if approval.wallet_id != input.wallet_id {
        return Err("The transaction review belongs to a different wallet.".to_owned());
    }
    if approval.expires_at <= now() {
        return Err("The transaction review expired. Prepare it again.".to_owned());
    }
    if let Some(mfw) = approval.mfw.as_ref() {
        let record = mfw_names::get(&app, &mfw.record_id)?;
        if mfw.kind == "commit" && record.recovery_exported_at.is_none() {
            approvals
                .0
                .lock()
                .map_err(|_| "Transaction approval state is busy.".to_owned())?
                .insert(input.pending_id.clone(), approval.clone());
            return Err(
                "Export and safely store the encrypted MFW recovery file before approving the commit."
                    .to_owned(),
            );
        }
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
        .commit_transaction(&input.wallet_id, &input.pending_id)?;
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
fn market_backup_url(kind: &str, timeframe: Option<&str>) -> Result<String, String> {
    const BASE: &str = "https://api-pub.bitfinex.com/v2";
    match kind {
        "ticker" if timeframe.is_none() => Ok(format!("{BASE}/ticker/tXMRUSD")),
        "chart" => {
            let (interval, limit) = match timeframe {
                Some("24H") => ("1h", 25),
                Some("7D") => ("6h", 29),
                Some("1M") => ("12h", 61),
                Some("1Y") => ("1D", 366),
                Some("Max") => ("1D", 10_000),
                _ => return Err("Unknown market chart timeframe.".to_owned()),
            };
            Ok(format!(
                "{BASE}/candles/trade:{interval}:tXMRUSD/hist?limit={limit}&sort=-1"
            ))
        }
        _ => Err("Unknown market backup request.".to_owned()),
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
    match finish_wallet_operation(app, state, sessions, wallet_id, wallet) {
        Ok(response) => Ok(response),
        Err(error) => {
            let _ = secure_store::delete_wallet_password(&registration_id);
            Err(error)
        }
    }
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
    // Only the historic Ledger Fast Wallet is physically represented by its
    // source Ledger file. A local view-only companion has its own encrypted
    // file and must therefore retain its own registration/credential.
    if registration.kind != "hardware" || registration.role.as_deref() != Some("fast") {
        return Ok(registration.clone());
    }
    let Some(source_wallet_id) = registration.source_wallet_id.as_deref() else {
        return Ok(registration.clone());
    };
    wallet_registry::list(app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == source_wallet_id)
        .ok_or_else(|| {
            "The linked Ledger wallet is missing. Remove this Fast Wallet and add the Ledger again."
                .to_owned()
        })
}

fn finish_wallet_operation(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    wallet_id: String,
    wallet: wallet_registry::RegisteredWallet,
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

    // Opening a wallet must be sufficient to start syncing.  Previously the
    // UI started the refresh worker without restoring its daemon profile, so
    // the core had no node height and remained at 0% forever.
    let profile = node_settings::load(app, &wallet.network)?;
    let mut node_password = if profile.password_stored {
        secure_store::load_node_daemon_password(&profile.network)?.unwrap_or_default()
    } else {
        String::new()
    };
    let configure_result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .set_daemon(native_wallet::DaemonConfig {
            wallet_id: &wallet_id,
            address: &profile.daemon_address,
            trusted: profile.trusted,
            use_ssl: profile.use_ssl,
            username: &profile.username,
            password: &node_password,
            proxy_address: &profile.proxy_address,
        });
    node_password.zeroize();
    if let Err(error) = configure_result {
        diagnostics::record(
            app,
            "wallet.node-configuration-failed",
            &[
                ("network", wallet.network.clone()),
                ("reason", "native-error".to_owned()),
            ],
        );
        return Err(format!(
            "Wallet opened, but the node could not be configured: {error}"
        ));
    }
    if let Err(error) = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .start_refresh(&wallet_id)
    {
        diagnostics::record(
            app,
            "wallet.refresh-start-failed",
            &[
                ("network", wallet.network.clone()),
                ("reason", "native-error".to_owned()),
            ],
        );
        return Err(format!(
            "Wallet opened, but refresh could not start: {error}"
        ));
    }
    diagnostics::record(
        app,
        "wallet.sync-started",
        &[
            ("network", wallet.network.clone()),
            ("nodeMode", profile.mode),
            ("usesTls", profile.use_ssl.to_string()),
        ],
    );
    Ok(WalletOperationResponse { wallet_id, wallet })
}

pub fn run() {
    // Fail closed when the OS credential store cannot be read. The renderer
    // can show the exact storage error, but native sessions must never open
    // before the app-wide boundary has been confirmed.
    let initially_locked = match secure_store::app_protection_configured() {
        Ok(_) => true,
        Err(error) => {
            eprintln!("MONERO_DESKTOP_APP_PROTECTION status-read-failed: {error}");
            true
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(NativeWalletState(Mutex::new(
            native_wallet::NativeWallet::new().expect("native wallet core initialization"),
        )))
        .manage(WalletSessionState(Mutex::new(HashMap::new())))
        .manage(FastWalletSessionState(Mutex::new(HashMap::new())))
        .manage(LedgerViewKeyExportState(Mutex::new(HashSet::new())))
        .manage(PendingTransactionApprovalState(Mutex::new(HashMap::new())))
        .manage(AppProtectionState(Mutex::new(initially_locked)))
        .manage(WindowSecurityState(Mutex::new(0)))
        .manage(
            enthusiast_v1::CommunityV1State::new()
                .expect("Monero Enthusiast native client initialization"),
        )
        .manage(community::CommunityState::new().expect("Community client initialization"))
        .setup(|app| {
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| "The main wallet window is unavailable.".to_owned())?;
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            main_window
                .set_content_protected(true)
                .map_err(|error| format!("Screen-capture protection failed: {error}"))?;

            let lifecycle_app = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(focused) = event {
                    let generation = {
                        let lifecycle = lifecycle_app.state::<WindowSecurityState>();
                        let Ok(mut current) = lifecycle.0.lock() else {
                            return;
                        };
                        *current = current.wrapping_add(1);
                        *current
                    };
                    if *focused {
                        return;
                    }
                    let lock_app_handle = lifecycle_app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(15));
                        let still_unfocused = lock_app_handle
                            .state::<WindowSecurityState>()
                            .0
                            .lock()
                            .map(|current| *current == generation)
                            .unwrap_or(false);
                        if !still_unfocused {
                            return;
                        }
                        let state = lock_app_handle.state::<NativeWalletState>();
                        let sessions = lock_app_handle.state::<WalletSessionState>();
                        let fast_sessions = lock_app_handle.state::<FastWalletSessionState>();
                        let approvals =
                            lock_app_handle.state::<PendingTransactionApprovalState>();
                        let protection = lock_app_handle.state::<AppProtectionState>();
                        let community_v1 =
                            lock_app_handle.state::<enthusiast_v1::CommunityV1State>();
                        if let Err(error) = lock_app_native(
                            &state,
                            &sessions,
                            &fast_sessions,
                            &approvals,
                            &protection,
                            &community_v1,
                        ) {
                            eprintln!(
                                "MONERO_DESKTOP_APP_PROTECTION background-lock-failed: {error}"
                            );
                        }
                    });
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
            app_protection_status,
            set_app_protection_password,
            verify_app_protection_password,
            set_app_protection_mode,
            verify_system_auth,
            lock_app,
            fetch_market_backup,
            ledger_transport_status,
            store_wallet_password,
            delete_wallet_password,
            create_wallet,
            restore_wallet_with_native_seed,
            restore_fast_wallet_with_native_seed,
            create_hardware_wallet,
            enable_ledger_read_only,
            create_ledger_read_only_from_device,
            wallet_open_requires_password,
            open_wallet,
            close_wallet,
            rename_wallet,
            remove_registered_wallet,
            list_registered_wallets,
            activate_registered_wallet,
            list_fast_wallets,
            open_fast_wallet,
            close_fast_wallet,
            remove_fast_wallet,
            present_fast_wallet_recovery_seed,
            create_fast_wallet,
            pair_private_fast_wallet_worker,
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
            set_daemon,
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
            wallet_transactions,
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

#[cfg(test)]
mod tests {
    use super::{
        market_backup_url, require_app_unlocked, validate_fast_wallet_removal_snapshot,
        wallet_file_path_is_available, AppProtectionState,
    };
    use std::{
        fs,
        sync::Mutex,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn native_authorization_fails_closed_while_the_app_is_locked() {
        let locked = AppProtectionState(Mutex::new(true));
        assert!(require_app_unlocked(&locked).is_err());

        let unlocked = AppProtectionState(Mutex::new(false));
        assert!(require_app_unlocked(&unlocked).is_ok());
    }

    #[test]
    fn market_backup_only_allows_expected_bitfinex_routes() {
        assert_eq!(
            market_backup_url("ticker", None).unwrap(),
            "https://api-pub.bitfinex.com/v2/ticker/tXMRUSD"
        );
        assert_eq!(
            market_backup_url("chart", Some("7D")).unwrap(),
            "https://api-pub.bitfinex.com/v2/candles/trade:6h:tXMRUSD/hist?limit=29&sort=-1"
        );
        assert!(market_backup_url("chart", Some("other")).is_err());
        assert!(market_backup_url("other", None).is_err());
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
