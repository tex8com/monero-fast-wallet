mod community;
mod desktop_notifications;
mod diagnostics;
mod fast_wallet;
mod linux_notification_agent;
mod native_wallet;
mod node_settings;
mod secure_store;
mod wallet_core;
mod wallet_registry;
mod windows_notification_agent;

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
use zeroize::Zeroize;

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
struct RestoreWalletInput {
    wallet_name: String,
    password: String,
    mnemonic: String,
    seed_offset: Option<String>,
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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletIdInput {
    wallet_id: String,
    account_index: Option<u32>,
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
#[serde(rename_all = "camelCase")]
struct FastWalletEnableInput {
    identity_id: String,
    scanner_url: String,
    scanner_auth_token: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FastWalletIdInput {
    identity_id: String,
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
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    desktop_notifications::status(&app)
}

#[tauri::command]
fn request_notification_installation(
    app: AppHandle,
    input: desktop_notifications::RequestNotificationInstallationInput,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    desktop_notifications::request_installation(&app, input)
}

#[tauri::command]
fn disable_notification_installation(
    app: AppHandle,
) -> Result<desktop_notifications::NotificationInstallationStatus, String> {
    desktop_notifications::disable_installation(&app)
}

#[tauri::command]
fn consume_pending_notification_open(
    app: AppHandle,
) -> Result<Option<desktop_notifications::NotificationEvent>, String> {
    desktop_notifications::consume_pending_open(&app)
}

#[tauri::command]
fn background_notification_agent_config_path(app: AppHandle) -> Result<Option<String>, String> {
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
fn ledger_transport_status(state: State<'_, NativeWalletState>) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .ledger_transport_status()
}

#[tauri::command]
fn store_wallet_password(wallet_id: String, password: String) -> Result<(), String> {
    secure_store::store_wallet_password(&wallet_id, password)
}

#[tauri::command]
fn delete_wallet_password(wallet_id: String) -> Result<(), String> {
    secure_store::delete_wallet_password(&wallet_id)
}

#[tauri::command]
fn create_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    mut input: CreateWalletInput,
) -> Result<WalletOperationResponse, String> {
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
fn restore_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    mut input: RestoreWalletInput,
) -> Result<WalletOperationResponse, String> {
    let wallet_name = next_wallet_file_name(&app, &input.wallet_name, "wallet")?;
    let wallet_network = input.network.clone();
    let restore_height = input.restore_height.filter(|height| *height > 0);
    let path = wallet_path(&app, &wallet_name)?;
    let mut password = wallet_password_or_generated(&mut input.password)?;
    let result = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .restore(
            &path,
            &password,
            &input.mnemonic,
            input.seed_offset.as_deref().unwrap_or(""),
            network(&input.network)?,
            input.restore_height.unwrap_or(0),
        );
    input.mnemonic.zeroize();
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
fn create_hardware_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    mut input: CreateHardwareWalletInput,
) -> Result<WalletOperationResponse, String> {
    let account_index = input.account_index.unwrap_or(0);
    let role = input.role.as_deref().unwrap_or("standard");
    if account_index > 1_000_000 || !matches!(role, "standard" | "fast") {
        return Err("The selected Ledger account is invalid.".to_owned());
    }
    if (role == "fast" && account_index != 1) || (role == "standard" && account_index != 0) {
        return Err("Ledger Fast Wallet uses the reserved account 1; the normal Ledger wallet uses account 0.".to_owned());
    }
    let create_fast = role == "standard" && input.create_fast.unwrap_or(true);
    let native_account_index = if create_fast { 1 } else { account_index };
    let prefix = if role == "fast" {
        "ledger-fast"
    } else {
        "ledger"
    };
    let wallet_name = next_wallet_file_name(&app, &input.wallet_name, prefix)?;
    let fast_wallet_name = if create_fast {
        Some(next_wallet_file_name(&app, "", "ledger-fast")?)
    } else {
        None
    };
    let wallet_network = input.network.clone();
    let restore_height = input.restore_height.filter(|height| *height > 0);
    let path = wallet_path(&app, &wallet_name)?;
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
            restore_height: input.restore_height.unwrap_or(0),
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
    let fast_registration = fast_wallet_name.map(|name| {
        wallet_registry::hardware_wallet(
            &name,
            &wallet_network,
            restore_height,
            Some(1),
            Some("fast"),
            Some(&registration.id),
        )
    });
    let response = finish_wallet_operation_with_password(
        &app,
        &state,
        &sessions,
        wallet_id,
        registration,
        password,
    )?;
    if let Some(fast_registration) = fast_registration {
        wallet_registry::upsert_preserving_active(&app, fast_registration)?;
    }
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
    input: EnableLedgerReadOnlyInput,
) -> Result<WalletOperationResponse, String> {
    let source = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == input.source_registration_id)
        .ok_or_else(|| "The selected Ledger wallet is no longer saved on this device.".to_owned())?;
    if source.kind != "hardware" || source.role.as_deref().unwrap_or("standard") != "standard" {
        return Err("Choose a normal Ledger wallet for the local read-only copy.".to_owned());
    }
    if input.source_wallet_id.trim().is_empty() {
        return Err("Open and unlock the Ledger wallet before enabling local read-only sync.".to_owned());
    }
    let active_native_id = sessions
        .0
        .lock()
        .map_err(|_| "Wallet session state is busy.".to_owned())?
        .get(&source.id)
        .cloned()
        .ok_or_else(|| "Open and unlock the Ledger wallet first, then approve Export view key on the Ledger.".to_owned())?;
    if active_native_id != input.source_wallet_id {
        return Err("The selected Ledger session changed. Open the Ledger wallet again and retry.".to_owned());
    }
    create_ledger_read_only_from_open_source(
        &app,
        &state,
        &sessions,
        &source,
        &active_native_id,
        input.restore_height,
        "open-ledger-session",
    )
}

/// Uses an already-open hardware session only long enough to request the
/// explicit Ledger view-key export. The value is never returned to React.
fn create_ledger_read_only_from_open_source(
    app: &AppHandle,
    state: &NativeWalletState,
    sessions: &WalletSessionState,
    source: &wallet_registry::RegisteredWallet,
    source_native_id: &str,
    requested_restore_height: Option<u64>,
    export_flow: &str,
) -> Result<WalletOperationResponse, String> {
    if wallet_registry::list(app)?.wallets.iter().any(|wallet| {
        wallet.kind == "view-only" && wallet.source_wallet_id.as_deref() == Some(source.id.as_str())
    }) {
        return Err("This Ledger already has a local read-only copy. Open it from your wallet list.".to_owned());
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
                &[("flow", export_flow.to_owned()), ("stage", "core".to_owned())],
            );
            return Err(error);
        }
    };
    let mut exported: NativeHardwareViewKeyExport = serde_json::from_str(&exported_json)
        .map_err(|_| "The Ledger returned an invalid view-key response.".to_owned())?;
    exported_json.zeroize();
    if exported.network != source.network || exported.address.trim().is_empty() || exported.private_view_key.trim().is_empty() {
        exported.private_view_key.zeroize();
        diagnostics::record(
            app,
            "ledger.view-key-export-failed",
            &[("flow", export_flow.to_owned()), ("stage", "verification".to_owned())],
        );
        return Err("The Ledger view key could not be verified for this wallet.".to_owned());
    }

    let wallet_name = next_wallet_file_name(&app, "", "ledger-read")?;
    let path = wallet_path(&app, &wallet_name)?;
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
                &[("flow", export_flow.to_owned()), ("stage", "read-only-create".to_owned())],
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
            &[("flow", export_flow.to_owned()), ("stage", "secure-store-write".to_owned())],
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
                &[("flow", export_flow.to_owned()), ("stage", "secure-store-verify".to_owned())],
            );
            return Err("The Ledger private view key could not be verified in secure storage.".to_owned());
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
                &[("flow", export_flow.to_owned()), ("stage", "secure-store-verify".to_owned())],
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
                &[("flow", export_flow.to_owned()), ("stage", "registration".to_owned())],
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
    input: CreateLedgerReadOnlyFromDeviceInput,
) -> Result<WalletOperationResponse, String> {
    let source = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == input.source_registration_id)
        .ok_or_else(|| "The selected Ledger wallet is no longer saved on this device.".to_owned())?;
    if source.kind != "hardware" || source.role.as_deref().unwrap_or("standard") != "standard" {
        return Err("Choose a normal Ledger wallet for the local read-only copy.".to_owned());
    }

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
    diagnostics::record(
        &app,
        "ledger.recovery-session-opened",
        &[],
    );

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
    result
}
#[tauri::command]
fn wallet_open_requires_password(
    app: AppHandle,
    input: WalletOpenCredentialInput,
) -> Result<bool, String> {
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
    mut input: OpenWalletInput,
) -> Result<WalletOperationResponse, String> {
    let wallet_name = input.wallet_name.clone();
    let wallet_network = input.network.clone();
    let restore_height = input.restore_height.filter(|height| *height > 0);
    let registration = registration_for_open(&app, &wallet_name, &wallet_network, restore_height)?;
    let physical_registration = physical_registration_for_open(&app, &registration)?;
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
    input: WalletIdInput,
) -> Result<(), String> {
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
    input: RenameWalletInput,
) -> Result<wallet_registry::RegisteredWallet, String> {
    wallet_registry::rename_wallet(&app, &input.wallet_id, &input.display_name)
}
#[tauri::command]
fn remove_registered_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    input: RemoveRegisteredWalletInput,
) -> Result<(), String> {
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
        .filter(|wallet| wallet.id == input.wallet_id || wallet.source_wallet_id.as_deref() == Some(input.wallet_id.as_str()))
        .filter_map(|wallet| {
            (wallet.kind == "view-only")
                .then(|| wallet.source_wallet_id.clone())
                .flatten()
        })
        .collect::<Vec<_>>();
    for source_id in removed_view_only_source_ids {
        let _ = secure_store::delete_ledger_private_view_key(&source_id);
    }
    if registry.wallets.iter().any(|wallet| wallet.id == input.wallet_id && wallet.kind == "hardware") {
        let _ = secure_store::delete_ledger_private_view_key(&input.wallet_id);
    }
    wallet_registry::remove(&app, &input.wallet_id)?;
    Ok(())
}
#[tauri::command]
fn list_registered_wallets(
    app: AppHandle,
    sessions: State<'_, WalletSessionState>,
) -> Result<Vec<RegisteredWalletView>, String> {
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
    wallet_id: String,
) -> Result<WalletOperationResponse, String> {
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
fn mark_wallet_seed_backed_up(
    app: AppHandle,
    wallet_id: String,
) -> Result<wallet_registry::RegisteredWallet, String> {
    wallet_registry::mark_seed_backed_up(&app, &wallet_id)
}
#[tauri::command]
fn list_fast_wallets(app: AppHandle) -> Result<Vec<fast_wallet::FastWalletRecord>, String> {
    fast_wallet::list(&app)
}
#[tauri::command]
fn open_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, FastWalletSessionState>,
    input: FastWalletIdInput,
) -> Result<FastWalletOpenResponse, String> {
    let wallet = fast_wallet::get(&app, &input.identity_id)?;
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
    input: FastWalletIdInput,
) -> Result<(), String> {
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
#[tauri::command]
fn create_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    sessions: State<'_, WalletSessionState>,
    mut input: CreateFastWalletInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    let source = wallet_registry::list(&app)?
        .wallets
        .into_iter()
        .find(|wallet| wallet.id == input.source_registration_id)
        .ok_or_else(|| "The source wallet is not saved on this device.".to_owned())?;
    if source.kind != "software" {
        return Err("Fast Wallet is currently available only for software wallets. Ledger Fast Wallet support is not implemented yet.".to_owned());
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
    // The renderer deliberately never receives the device-held wallet
    // credential. A blank UI value therefore means "use the existing secure
    // credential for this already unlocked source wallet".
    let mut source_password = if input.password.trim().is_empty() {
        secure_store::load_wallet_password(&source.id)?.ok_or_else(|| {
            "The source wallet credential is not available on this device.".to_owned()
        })?
    } else {
        std::mem::take(&mut input.password)
    };
    input.password.zeroize();
    let raw = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .create_fast_receive_identity(native_wallet::FastReceiveIdentityCreate {
            source_wallet_id: &source_session_id,
            identity_id: &identity_id,
            path: &path,
            password: &source_password,
            label: &label,
            restore_height,
            derivation_index,
        });
    let mut password_for_store = source_password.clone();
    source_password.zeroize();
    let mut raw = match raw {
        Ok(value) => value,
        Err(error) => {
            password_for_store.zeroize();
            return Err(error);
        }
    };
    // Retain the credential before parsing public metadata. It never crosses
    // the Tauri boundary and the local identity remains recoverable if a
    // later metadata write is interrupted.
    secure_store::store_fast_wallet_password(&identity_id, password_for_store)?;
    let parsed = serde_json::from_str::<NativeFastWalletIdentity>(&raw);
    raw.zeroize();
    let identity = parsed.map_err(|_| "The native Fast Wallet identity was invalid.".to_owned())?;
    if identity.id != identity_id
        || identity.network != source.network
        || identity.scanner_status != "local-only"
    {
        return Err(
            "The native Fast Wallet identity did not match the selected source wallet.".to_owned(),
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
        identity.id.clone(),
        identity.label,
        identity.address,
        identity.network,
        source.id,
        native_restore_height,
        native_derivation_index,
    )?;
    let record = fast_wallet::insert(&app, record)?;
    Ok(record)
}
#[tauri::command]
async fn enable_fast_wallet(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    mut input: FastWalletEnableInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    let scanner_url = fast_wallet::scanner_url(&input.scanner_url)?;
    if let Some(mut supplied_token) = input.scanner_auth_token.take() {
        let token = supplied_token.trim().to_owned();
        supplied_token.zeroize();
        if !token.is_empty() {
            secure_store::store_fast_scanner_token(&record.id, token)?;
        }
    }
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
#[tauri::command]
async fn refresh_fast_wallet_status(
    app: AppHandle,
    input: FastWalletIdInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    let scanner_url = if record.scanner_url.is_empty() {
        return Ok(record);
    } else {
        fast_wallet::scanner_url(&record.scanner_url)?
    };
    let mut token = secure_store::load_fast_scanner_token(&record.id)?;
    let result = get_fast_wallet_scanner_status(&scanner_url, &record.id, token.as_deref()).await;
    if let Some(value) = token.as_mut() {
        value.zeroize();
    }
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
    input: FastWalletIdInput,
) -> Result<fast_wallet::FastWalletRecord, String> {
    let mut record = fast_wallet::get(&app, &input.identity_id)?;
    if !record.scanner_url.is_empty() {
        let scanner_url = fast_wallet::scanner_url(&record.scanner_url)?;
        let mut token = secure_store::load_fast_scanner_token(&record.id)?;
        let result =
            delete_fast_wallet_scanner_watch(&scanner_url, &record.id, token.as_deref()).await;
        if let Some(value) = token.as_mut() {
            value.zeroize();
        }
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
    let mut token = secure_store::load_fast_scanner_token(&record.id)?;
    let mut request = ScannerRegisterRequest {
        identity_id: record.id.clone(),
        address: record.address.clone(),
        private_view_key: std::mem::take(&mut payload.private_view_key),
        network: record.network.clone(),
        restore_height: record.restore_height,
        device_id: subscription_id.map(str::to_owned),
    };
    let mut call = client
        .post(format!("{scanner_url}/v1/fast-receive/watch"))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(value) = token.as_deref() {
        call = call.bearer_auth(value);
    }
    let response = call.json(&request).send().await;
    request.private_view_key.zeroize();
    if let Some(value) = token.as_mut() {
        value.zeroize();
    }
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
    token: Option<&str>,
) -> Result<Option<ScannerWatchResponse>, String> {
    fast_wallet::validate_id(identity_id)?;
    let client = fast_scanner_client()?;
    let mut call = client
        .get(format!("{scanner_url}/v1/fast-receive/watch/{identity_id}"))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(value) = token {
        call = call.bearer_auth(value);
    }
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
    token: Option<&str>,
) -> Result<ScannerWatchResponse, String> {
    fast_wallet::validate_id(identity_id)?;
    let client = fast_scanner_client()?;
    let mut call = client
        .delete(format!("{scanner_url}/v1/fast-receive/watch/{identity_id}"))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(value) = token {
        call = call.bearer_auth(value);
    }
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
    network: String,
) -> Result<node_settings::NodeProfile, String> {
    node_settings::load(&app, &network)
}
#[tauri::command]
fn save_node_settings(
    app: AppHandle,
    state: State<'_, NativeWalletState>,
    mut input: NodeSettingsInput,
) -> Result<node_settings::NodeProfile, String> {
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
fn set_daemon(state: State<'_, NativeWalletState>, mut input: DaemonInput) -> Result<(), String> {
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
    input: WalletIdInput,
) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .start_refresh(&input.wallet_id)
}
#[tauri::command]
fn stop_wallet_refresh(
    state: State<'_, NativeWalletState>,
    input: WalletIdInput,
) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .stop_refresh(&input.wallet_id)
}
#[tauri::command]
fn wallet_address(
    state: State<'_, NativeWalletState>,
    input: WalletIdInput,
) -> Result<String, String> {
    let account_index = checked_account_index(input.account_index)?;
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .address(&input.wallet_id, account_index, 0)
}
#[tauri::command]
fn wallet_recovery_seed(
    state: State<'_, NativeWalletState>,
    input: WalletIdInput,
) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .recovery_seed(&input.wallet_id)
}
#[tauri::command]
fn wallet_snapshot(
    state: State<'_, NativeWalletState>,
    input: WalletIdInput,
) -> Result<String, String> {
    let account_index = checked_account_index(input.account_index)?;
    let wallet = state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?;
    let raw = wallet.snapshot(&input.wallet_id)?;
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
        serde_json::Value::String(wallet.address(&input.wallet_id, account_index, 0)?),
    );
    object.insert(
        "balanceAtomic".to_owned(),
        serde_json::Value::String(wallet.balance(&input.wallet_id, account_index, false)?),
    );
    object.insert(
        "unlockedBalanceAtomic".to_owned(),
        serde_json::Value::String(wallet.balance(&input.wallet_id, account_index, true)?),
    );
    serde_json::to_string(&snapshot)
        .map_err(|_| "The native wallet snapshot could not be encoded.".to_owned())
}
#[tauri::command]
fn wallet_balance(
    state: State<'_, NativeWalletState>,
    input: WalletIdInput,
) -> Result<String, String> {
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
    input: WalletIdInput,
) -> Result<String, String> {
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
    input: SubaddressInput,
) -> Result<String, String> {
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
    input: WalletIdInput,
) -> Result<String, String> {
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
    input: PrepareTransactionInput,
) -> Result<String, String> {
    let account_index = checked_account_index(input.account_index)?;
    state
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
        )
}
#[tauri::command]
fn commit_transaction(
    state: State<'_, NativeWalletState>,
    input: CommitTransactionInput,
) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .commit_transaction(&input.wallet_id, &input.pending_id)
}
#[tauri::command]
fn wallet_hardware_status(
    state: State<'_, NativeWalletState>,
    input: WalletIdInput,
) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .hardware_status(&input.wallet_id)
}
#[tauri::command]
fn reconnect_hardware_wallet(
    state: State<'_, NativeWalletState>,
    input: WalletIdInput,
) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Native wallet is busy.".to_owned())?
        .reconnect_hardware(&input.wallet_id)
}
#[tauri::command]
fn show_hardware_wallet_address(
    state: State<'_, NativeWalletState>,
    input: HardwareAddressInput,
) -> Result<String, String> {
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
) -> Result<community::CommunityProfile, String> {
    state.load_profile().await
}
#[tauri::command]
async fn community_update_profile(
    state: State<'_, community::CommunityState>,
    input: community::CommunityProfileUpdateInput,
) -> Result<community::CommunityProfile, String> {
    state.update_profile(input).await
}
#[tauri::command]
async fn community_list_nearby(
    state: State<'_, community::CommunityState>,
    input: community::CommunityRadiusInput,
) -> Result<Vec<community::CommunityNearby>, String> {
    state.list_nearby(input.radius_km).await
}
#[tauri::command]
async fn community_list_contacts(
    state: State<'_, community::CommunityState>,
) -> Result<Vec<community::CommunityContact>, String> {
    state.list_contacts().await
}
#[tauri::command]
async fn community_request_contact(
    state: State<'_, community::CommunityState>,
    input: community::CommunityPeerInput,
) -> Result<(), String> {
    state.request_contact(&input.peer_id).await
}
#[tauri::command]
async fn community_accept_contact(
    state: State<'_, community::CommunityState>,
    input: community::CommunityPeerInput,
) -> Result<(), String> {
    state.accept_contact(&input.peer_id).await
}
#[tauri::command]
async fn community_list_messages(
    state: State<'_, community::CommunityState>,
    input: community::CommunityMessagesInput,
) -> Result<Vec<community::CommunityMessage>, String> {
    state.list_messages(&input.peer_id, input.after_ms).await
}
#[tauri::command]
async fn community_send_message(
    state: State<'_, community::CommunityState>,
    input: community::CommunitySendMessageInput,
) -> Result<community::CommunityMessage, String> {
    state.send_message(&input.peer_id, &input.body).await
}
#[tauri::command]
async fn community_block_profile(
    state: State<'_, community::CommunityState>,
    input: community::CommunityPeerInput,
) -> Result<(), String> {
    state.block_profile(&input.peer_id).await
}
#[tauri::command]
async fn community_report_profile(
    state: State<'_, community::CommunityState>,
    input: community::CommunityReportInput,
) -> Result<(), String> {
    state.report_profile(&input.peer_id, &input.reason).await
}
#[tauri::command]
async fn community_delete_identity(
    state: State<'_, community::CommunityState>,
) -> Result<(), String> {
    state.delete_identity().await
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
            &[("kind", wallet.kind.clone()), ("reason", "secure-store".to_owned())],
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
        &[("kind", wallet.kind.clone()), ("verified", "true".to_owned())],
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
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(NativeWalletState(Mutex::new(
            native_wallet::NativeWallet::new().expect("native wallet core initialization"),
        )))
        .manage(WalletSessionState(Mutex::new(HashMap::new())))
        .manage(FastWalletSessionState(Mutex::new(HashMap::new())))
        .manage(community::CommunityState::new().expect("Community client initialization"))
        .setup(|app| {
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
            fetch_market_backup,
            ledger_transport_status,
            store_wallet_password,
            delete_wallet_password,
            create_wallet,
            restore_wallet,
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
            mark_wallet_seed_backed_up,
            list_fast_wallets,
            open_fast_wallet,
            close_fast_wallet,
            create_fast_wallet,
            enable_fast_wallet,
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
            wallet_recovery_seed,
            wallet_snapshot,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monero Fast Wallet desktop");
}

#[cfg(test)]
mod tests {
    use super::{market_backup_url, wallet_file_path_is_available};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

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
}
