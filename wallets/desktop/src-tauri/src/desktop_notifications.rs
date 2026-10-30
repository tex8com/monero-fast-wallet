use reqwest::{header, redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::{
    ffi::CStr,
    os::raw::{c_char, c_int},
};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const NOTIFICATION_DIR: &str = "notifications";
const INSTALLATION_FILE: &str = "desktop-installation.json";
const BACKGROUND_AGENT_FILE: &str = "background-agent.json";
const PENDING_OPEN_FILE: &str = "pending-open-event.json";
const CONTRACT_VERSION: u8 = 5;
static INSTALLATION_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static REGISTRATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const PREFERENCE_CHANGED: &str = "Notification preferences changed during registration. Try again.";

// These symbols are implemented by the AppKit bridge.  Keep the declaration
// macOS uses APNs. Windows and Linux use the private background agent and
// must not try to link an APNs implementation.
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn tex8_desktop_apns_register() -> c_int;
    fn tex8_desktop_apns_resume(retry: c_int) -> c_int;
    fn tex8_desktop_apns_attempt_elapsed_millis() -> u64;
    fn tex8_desktop_apns_refresh_authorization() -> u64;
    fn tex8_desktop_apns_authorization_status(query: u64) -> *const c_char;
    fn tex8_desktop_apns_install_handler() -> c_int;
    fn tex8_desktop_apns_device_token() -> *const c_char;
    fn tex8_desktop_apns_status() -> *const c_char;
    fn tex8_desktop_apns_take_pending_event() -> *const c_char;
    fn tex8_desktop_apns_take_received_event() -> *const c_char;
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInstallation {
    pub version: u8,
    pub tenant_id: String,
    pub shop_id: String,
    pub app_id: String,
    pub installation_id: String,
    pub platform: String,
    pub provider: String,
    pub endpoint: String,
    pub permission_status: String,
    pub locale: Option<String>,
    pub app_version: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub preference_generation: u64,
    pub background_mode_enabled: bool,
    pub provider_status: String,
    #[serde(default)]
    pub gateway_status: String,
    #[serde(default)]
    pub gateway_generation: Option<u64>,
    #[serde(default)]
    pub provider_token_hash: Option<String>,
    #[serde(default)]
    pub gateway_lease_expires_at: Option<u64>,
    #[serde(default)]
    pub gateway_checked_at: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestNotificationInstallationInput {
    pub permission_status: String,
    pub locale: Option<String>,
    pub app_version: Option<String>,
    pub background_mode_enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEvent {
    pub id: String,
    pub category: String,
    pub deep_link: String,
    pub received_at: String,
    pub opened: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInstallationStatus {
    pub installation: NotificationInstallation,
    pub delivery: String,
    pub background_mode_supported: bool,
    pub background_agent_config_path: Option<String>,
    pub background_agent_status: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopProviderRegistrationRequest<'a> {
    provider: &'a str,
    token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRegistrationResponse {
    accepted: bool,
    provider: String,
    provider_token_hash: String,
    generation: u64,
    accepted_at: u64,
    lease_expires_at: u64,
    delivery_state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderStatusResponse {
    registered: bool,
    provider: Option<String>,
    provider_token_hash: Option<String>,
    generation: Option<u64>,
    accepted_at: Option<u64>,
    lease_expires_at: Option<u64>,
    delivery_state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundAgentConfig {
    version: u8,
    installation_id: String,
    platform: String,
    provider: String,
    service_url: String,
    app_command: Option<String>,
    enabled: bool,
}

pub fn status(app: &AppHandle) -> Result<NotificationInstallationStatus, String> {
    let mut installation = load_or_create(app)?;
    let expected = installation.clone();
    refresh_platform_endpoint(&mut installation);
    installation = persist_provider_status(app, &expected, &installation)?;
    status_for_installation(app, installation)
}

pub fn request_installation(
    app: &AppHandle,
    input: RequestNotificationInstallationInput,
) -> Result<NotificationInstallationStatus, String> {
    validate_permission(&input.permission_status)?;
    let now = now();
    let _record = installation_lock()?;
    let mut installation = load_or_create_locked(app)?;
    installation.preference_generation = next_preference_generation(installation.preference_generation)?;
    installation.permission_status = input.permission_status;
    installation.locale = input.locale.filter(|value| !value.trim().is_empty());
    installation.app_version = input.app_version.filter(|value| !value.trim().is_empty());
    installation.enabled = installation.permission_status == "authorized";
    if installation.enabled && platform() == "macos" {
        request_macos_apns_registration();
    }
    refresh_platform_endpoint(&mut installation);
    installation.background_mode_enabled = installation.enabled
        && matches!(platform(), "windows" | "linux")
        && input.background_mode_enabled.unwrap_or(true);
    installation.provider_status = provider_status(&installation);
    installation.updated_at = now;
    write_installation(app, &installation)?;
    write_background_agent_config(app, &installation)?;
    crate::linux_notification_agent::reconcile(app, installation.background_mode_enabled)?;
    crate::windows_notification_agent::reconcile(app, installation.background_mode_enabled)?;
    status_for_installation(app, installation)
}

pub async fn reconcile_gateway(app: &AppHandle) -> Result<NotificationInstallationStatus, String> {
    let _registration = REGISTRATION_LOCK.lock().await;
    reconcile_gateway_locked(app, false).await
}

fn current_background_agent_status(
    app: &AppHandle,
    installation: &NotificationInstallation,
) -> Result<Option<String>, String> {
    if !matches!(installation.provider.as_str(), "windows-agent" | "linux-agent") {
        return Ok(None);
    }
    if !installation.enabled || !installation.background_mode_enabled {
        return Ok(Some("disabled".to_owned()));
    }
    Ok(Some(crate::background_agent_health::status(
        &notification_path(app, "agent-health.json")?, now(),
    ).to_owned()))
}

async fn reconcile_background_agent(
    app: &AppHandle,
    expected: &NotificationInstallation,
    retry: bool,
) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static RECONCILED: AtomicBool = AtomicBool::new(false);
        if !expected.background_mode_enabled { return Ok(()); }
        if !retry && RECONCILED.load(Ordering::SeqCst)
            && current_background_agent_status(app, expected)?.as_deref() == Some("connected")
        { return Ok(()); }
        let handle = app.clone();
        tokio::task::spawn_blocking(move || {
            crate::windows_notification_agent::reconcile(&handle, true)?;
            crate::linux_notification_agent::reconcile(&handle, true)
        }).await.map_err(|_| "Background notification startup could not be checked.".to_owned())??;
        ensure_preference_current(app, expected)?;
        RECONCILED.store(true, Ordering::SeqCst);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = (app, expected, retry);
    Ok(())
}

pub async fn disable_delivery(app: &AppHandle) -> Result<NotificationInstallationStatus, String> {
    // Finish any provider POST before removing delivery. Persist the user's
    // off choice before awaiting the network, even if the remote call fails.
    let _registration = REGISTRATION_LOCK.lock().await;
    let had_gateway_registration = load_or_create(app)?.gateway_status == "active";
    let status = disable_installation(app)?;
    if had_gateway_registration {
        crate::fast_wallet_enrollment::disable_delivery(app).await?;
    }
    Ok(status)
}

async fn reconcile_gateway_locked(app: &AppHandle, retry: bool) -> Result<NotificationInstallationStatus, String> {
    let mut installation = load_or_create(app)?;
    let expected = installation.clone();
    refresh_platform_endpoint(&mut installation);
    if !installation.enabled {
        return status_for_installation(app, installation);
    }
    reconcile_background_agent(app, &expected, retry).await?;
    resume_macos_apns_registration(app, &expected, &mut installation, retry).await?;
    refresh_platform_endpoint(&mut installation);
    write_installation_if_current(app, &expected, &installation)?;
    let (provider, token) = match installation.provider.as_str() {
        "apns" if installation.provider_status == "ready" && is_apns_device_token(&installation.endpoint) => {
            ("apns", installation.endpoint.trim())
        }
        "apns" => {
            installation.gateway_status = "provider-pending".to_owned();
            installation.gateway_checked_at = Some(now());
            write_installation_if_current(app, &expected, &installation)?;
            return status_for_installation(app, installation);
        }
        "windows-agent" | "linux-agent" if installation.background_mode_enabled => {
            ("desktop_wss", "")
        }
        _ => return status_for_installation(app, installation),
    };
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let current_time = now();
    let locally_current = installation.gateway_status == "active"
        && installation.provider_token_hash.as_deref() == Some(token_hash.as_str())
        && installation
            .gateway_lease_expires_at
            .is_some_and(|expires_at| expires_at > current_time.saturating_add(7 * 24 * 60 * 60));
    if locally_current
        && installation
            .gateway_checked_at
            .is_some_and(|checked_at| checked_at.saturating_add(24 * 60 * 60) > current_time)
    {
        return status_for_installation(app, installation);
    }
    let mut auth =
        crate::secure_store::load_notification_installation_auth(&installation.installation_id)?
            .ok_or_else(|| "The notification installation credential is missing.".to_owned())?;

    if locally_current {
        let status_response = desktop_http_client()?
            .get(format!(
                "{}/api/v1/installations/provider",
                gateway_origin()?
            ))
            .header(header::ACCEPT, "application/json")
            .header(
                "x-fast-wallet-installation-id",
                &installation.installation_id,
            )
            .header("x-fast-wallet-installation-auth", &auth)
            .send()
            .await;
        if let Ok(response) = status_response {
            if response.status().is_success() {
                if let Ok(bytes) = response.bytes().await {
                    if bytes.len() <= 16 * 1024 {
                        if let Ok(status) = serde_json::from_slice::<ProviderStatusResponse>(&bytes)
                        {
                            let confirmed = status.registered
                                && status.provider.as_deref() == Some(provider)
                                && status.provider_token_hash.as_deref()
                                    == Some(token_hash.as_str())
                                && status.generation == installation.gateway_generation
                                && status
                                    .accepted_at
                                    .is_some_and(|accepted_at| accepted_at > 0)
                                && status.lease_expires_at.is_some_and(|expires_at| {
                                    expires_at > current_time.saturating_add(7 * 24 * 60 * 60)
                                })
                                && status.delivery_state == "active";
                            if confirmed {
                                installation.gateway_lease_expires_at = status.lease_expires_at;
                                installation.gateway_checked_at = Some(current_time);
                                write_installation_if_current(app, &expected, &installation)?;
                                zeroize::Zeroize::zeroize(&mut auth);
                                return status_for_installation(app, installation);
                            }
                        }
                    }
                }
            }
        } else {
            // The last confirmed lease remains usable during a temporary
            // outage. Do not force a re-registration or show a false failure.
            zeroize::Zeroize::zeroize(&mut auth);
            return status_for_installation(app, installation);
        }
    }

    let response = desktop_http_client()?
        .post(format!(
            "{}/api/v1/installations/desktop-provider",
            gateway_origin()?
        ))
        .header(header::ACCEPT, "application/json")
        .header(
            "x-fast-wallet-installation-id",
            &installation.installation_id,
        )
        .header("x-fast-wallet-installation-auth", &auth)
        .json(&DesktopProviderRegistrationRequest { provider, token })
        .send()
        .await;
    zeroize::Zeroize::zeroize(&mut auth);
    let response = match response {
        Ok(response) if response.status().is_success() => response,
        Ok(_) => {
            installation.gateway_status = "needs-refresh".to_owned();
            installation.gateway_checked_at = Some(current_time);
            write_installation_if_current(app, &expected, &installation)?;
            return Err("The desktop notification service rejected this installation.".to_owned());
        }
        Err(_) => {
            installation.gateway_status = "needs-refresh".to_owned();
            installation.gateway_checked_at = Some(current_time);
            write_installation_if_current(app, &expected, &installation)?;
            return Err("The desktop notification service is unavailable.".to_owned());
        }
    };
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The desktop notification response could not be read.".to_owned())?;
    if bytes.len() > 16 * 1024 {
        return Err("The desktop notification response was too large.".to_owned());
    }
    let accepted: ProviderRegistrationResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "The desktop notification response was invalid.".to_owned())?;
    if !accepted.accepted
        || accepted.provider != provider
        || accepted.provider_token_hash != token_hash
        || accepted.generation == 0
        || accepted.accepted_at == 0
        || accepted.lease_expires_at <= current_time
        || accepted.delivery_state != "active"
    {
        return Err("The desktop notification registration was not confirmed.".to_owned());
    }
    installation.gateway_status = "active".to_owned();
    installation.gateway_generation = Some(accepted.generation);
    installation.provider_token_hash = Some(accepted.provider_token_hash);
    installation.gateway_lease_expires_at = Some(accepted.lease_expires_at);
    installation.gateway_checked_at = Some(current_time);
    installation.updated_at = current_time;
    write_installation_if_current(app, &expected, &installation)?;
    status_for_installation(app, installation)
}

pub fn disable_installation(app: &AppHandle) -> Result<NotificationInstallationStatus, String> {
    let _record = installation_lock()?;
    let mut installation = load_or_create_locked(app)?;
    installation.preference_generation = next_preference_generation(installation.preference_generation)?;
    installation.enabled = false;
    installation.background_mode_enabled = false;
    installation.permission_status = "denied".to_owned();
    installation.provider_status = provider_status(&installation);
    installation.gateway_status = "disabled".to_owned();
    installation.updated_at = now();
    write_installation(app, &installation)?;
    write_background_agent_config(app, &installation)?;
    crate::linux_notification_agent::reconcile(app, false)?;
    crate::windows_notification_agent::reconcile(app, false)?;
    status_for_installation(app, installation)
}

pub fn consume_pending_open(app: &AppHandle) -> Result<Option<NotificationEvent>, String> {
    if let Some(raw) = macos_apns_pending_event() {
        let event = serde_json::from_str::<NotificationEvent>(&raw)
            .map_err(|_| "Pending notification event is invalid.".to_owned())?;
        if !valid_open_event(&event) {
            return Err("Pending notification event is invalid.".to_owned());
        }
        return Ok(Some(event));
    }
    let path = pending_open_path(app)?;
    let raw = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Pending notification event could not be read.".to_owned()),
    };
    let event = serde_json::from_str::<NotificationEvent>(&raw)
        .map_err(|_| "Pending notification event is invalid.".to_owned())?;
    if !valid_open_event(&event) {
        return Err("Pending notification event is invalid.".to_owned());
    }
    crate::notification_inbox::persist_then_remove(&path, || record_notification_received(app, &event))?;
    Ok(Some(event))
}

pub fn initialize_notification_open_handler() {
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = tex8_desktop_apns_install_handler();
    }
}

fn valid_open_event(event: &NotificationEvent) -> bool {
    if !event.opened {
        return false;
    }
    let opaque_id = ((event.id.len() == 68
        && (event.id.starts_with("evt_") || event.id.starts_with("sig_")))
        || (event.id.len() == 39 && event.id.starts_with("fwpush_")))
        && event.id[event.id.find('_').unwrap_or(0) + 1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    if !opaque_id {
        return false;
    }
    if event.category == crate::notification_test::CATEGORY {
        return event.deep_link == crate::notification_test::DEEP_LINK;
    }
    if event.category == "monero.fast_wallet.incoming" {
        return event.deep_link == "tex8://notification/incoming";
    }
    if event.category != "monero.fast_wallet.vanity" {
        return false;
    }
    let Some(order_id) = event.deep_link.strip_prefix("mfw://vanity/order/") else {
        return false;
    };
    order_id.len() == 36
        && order_id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

#[cfg(target_os = "macos")]
fn macos_apns_pending_event() -> Option<String> {
    unsafe { c_string(tex8_desktop_apns_take_pending_event()) }
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn macos_apns_pending_event() -> Option<String> {
    None
}

pub fn background_agent_config_path(app: &AppHandle) -> Result<Option<String>, String> {
    if !matches!(platform(), "windows" | "linux") {
        return Ok(None);
    }
    Ok(Some(
        notification_path(app, BACKGROUND_AGENT_FILE)?
            .to_string_lossy()
            .into_owned(),
    ))
}

fn status_for_installation(
    app: &AppHandle,
    mut installation: NotificationInstallation,
) -> Result<NotificationInstallationStatus, String> {
    installation.provider_status = provider_status(&installation);
    if installation.gateway_status == "active" && !gateway_current(&installation, now()) {
        installation.gateway_status = if installation.gateway_lease_expires_at.is_none_or(|expires| expires <= now()) {
            "expired"
        } else {
            "needs-refresh"
        }.to_owned();
    }
    let background_agent_status = current_background_agent_status(app, &installation)?;
    let actual_delivery = if background_agent_status.as_deref().is_some_and(|status| status != "connected")
        && installation.enabled { "local-while-open".to_owned() } else { delivery(&installation) };
    Ok(NotificationInstallationStatus {
        delivery: actual_delivery,
        // APNs owns closed-app delivery on macOS. The optional local agent is
        // intentionally a Windows/Linux feature until a macOS fallback exists.
        background_mode_supported: matches!(platform(), "windows" | "linux"),
        background_agent_config_path: background_agent_config_path(app)?,
        background_agent_status,
        installation,
    })
}

fn load_or_create(app: &AppHandle) -> Result<NotificationInstallation, String> {
    let _record = installation_lock()?;
    load_or_create_locked(app)
}

fn load_or_create_locked(app: &AppHandle) -> Result<NotificationInstallation, String> {
    let (mut installation, created) = match load(app)? {
        Some(installation) => (installation, false),
        None => (default_installation()?, true),
    };
    ensure_installation_auth(&installation.installation_id)?;
    let migrated = installation.version < CONTRACT_VERSION;
    if migrated {
        installation.version = CONTRACT_VERSION;
        installation.gateway_status = "unregistered".to_owned();
    }
    if created || migrated {
        write_installation(app, &installation)?;
        write_background_agent_config(app, &installation)?;
    }
    Ok(installation)
}

fn default_installation() -> Result<NotificationInstallation, String> {
    let timestamp = now();
    Ok(NotificationInstallation {
        version: CONTRACT_VERSION,
        tenant_id: "tex8".to_owned(),
        shop_id: "monero-wallet".to_owned(),
        app_id: "monero-wallet-desktop".to_owned(),
        installation_id: format!("mwp_desktop_{}", random_hex_16()?),
        platform: platform().to_owned(),
        provider: provider().to_owned(),
        endpoint: default_endpoint(),
        permission_status: "unknown".to_owned(),
        locale: None,
        app_version: None,
        enabled: false,
        preference_generation: 0,
        background_mode_enabled: false,
        provider_status: "not-configured".to_owned(),
        gateway_status: "unregistered".to_owned(),
        gateway_generation: None,
        provider_token_hash: None,
        gateway_lease_expires_at: None,
        gateway_checked_at: None,
        created_at: timestamp,
        updated_at: timestamp,
    })
}

fn ensure_installation_auth(installation_id: &str) -> Result<(), String> {
    if crate::secure_store::load_notification_installation_auth(installation_id)?.is_some() {
        return Ok(());
    }
    crate::secure_store::store_notification_installation_auth(installation_id, random_hex_32()?)
}

fn load(app: &AppHandle) -> Result<Option<NotificationInstallation>, String> {
    let path = notification_path(app, INSTALLATION_FILE)?;
    let raw = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Desktop notification installation could not be read.".to_owned()),
    };
    let installation = serde_json::from_str::<NotificationInstallation>(&raw)
        .map_err(|_| "Desktop notification installation is invalid.".to_owned())?;
    normalize_loaded_installation(installation, platform(), provider(), default_endpoint).map(Some)
}

fn normalize_loaded_installation(
    mut installation: NotificationInstallation,
    native_platform: &str,
    native_provider: &str,
    new_endpoint: fn() -> String,
) -> Result<NotificationInstallation, String> {
    // Earlier Windows builds used WNS directly. Keep their notification choice,
    // but never reuse a WNS channel or lease as a background-agent credential.
    let legacy_wns = native_platform == "windows"
        && installation.platform == "windows"
        && installation.provider == "wns"
        && matches!(installation.version, 1 | 2 | 3 | 4)
        && installation.tenant_id == "tex8"
        && installation.shop_id == "monero-wallet"
        && installation.app_id == "monero-wallet-desktop";
    if !matches!(installation.version, 1 | 2 | 3 | 4 | CONTRACT_VERSION)
        || installation.installation_id.is_empty()
        || installation.installation_id.len() > 80
        || !(legacy_wns || matches!(
            installation.provider.as_str(),
            "apns" | "windows-agent" | "linux-agent" | "tauri-local"
        ))
    {
        return Err("Desktop notification installation is invalid.".to_owned());
    }
    installation.platform = native_platform.to_owned();
    installation.provider = native_provider.to_owned();
    if legacy_wns {
        installation.provider_status = "not-configured".to_owned();
        installation.gateway_status = "unregistered".to_owned();
        installation.gateway_generation = None;
        installation.provider_token_hash = None;
        installation.gateway_lease_expires_at = None;
        installation.gateway_checked_at = None;
    }
    if legacy_wns || installation.endpoint.trim().is_empty() {
        installation.endpoint = new_endpoint();
    }
    Ok(installation)
}

fn write_installation(
    app: &AppHandle,
    installation: &NotificationInstallation,
) -> Result<(), String> {
    let path = notification_path(app, INSTALLATION_FILE)?;
    write_json(
        path,
        installation,
        "Desktop notification installation could not be saved.",
    )
}

fn installation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    INSTALLATION_STATE_LOCK.lock().map_err(|_| "Notification installation state is busy.".to_owned())
}

fn next_preference_generation(current: u64) -> Result<u64, String> {
    current.checked_add(1).ok_or_else(|| "Notification preference generation is invalid.".to_owned())
}

fn preference_current(expected: &NotificationInstallation, current: &NotificationInstallation) -> bool {
    expected.installation_id == current.installation_id && crate::apns_registration::preference_matches(
        (expected.preference_generation, expected.enabled, &expected.permission_status),
        (current.preference_generation, current.enabled, &current.permission_status))
}

fn write_installation_if_current(
    app: &AppHandle,
    expected: &NotificationInstallation,
    installation: &NotificationInstallation,
) -> Result<(), String> {
    let _record = installation_lock()?;
    let current = load(app)?.ok_or_else(|| PREFERENCE_CHANGED.to_owned())?;
    if !preference_current(expected, &current) { return Err(PREFERENCE_CHANGED.to_owned()); }
    write_installation(app, installation)
}

fn persist_provider_status(
    app: &AppHandle,
    expected: &NotificationInstallation,
    observed: &NotificationInstallation,
) -> Result<NotificationInstallation, String> {
    let _record = installation_lock()?;
    let mut current = load(app)?.ok_or_else(|| PREFERENCE_CHANGED.to_owned())?;
    if !preference_current(expected, &current) { return Ok(current); }
    if current.endpoint != observed.endpoint || current.provider_status != observed.provider_status {
        current.endpoint = observed.endpoint.clone();
        current.provider_status = observed.provider_status.clone();
        current.updated_at = now();
        write_installation(app, &current)?;
    }
    Ok(current)
}

fn write_background_agent_config(
    app: &AppHandle,
    installation: &NotificationInstallation,
) -> Result<(), String> {
    let path = notification_path(app, BACKGROUND_AGENT_FILE)?;
    if !matches!(platform(), "windows" | "linux") {
        return Ok(());
    }
    let config = BackgroundAgentConfig {
        version: CONTRACT_VERSION,
        installation_id: installation.installation_id.clone(),
        platform: installation.platform.clone(),
        provider: installation.provider.clone(),
        service_url: notification_service_url(),
        // Persist the absolute application executable while the app is alive.
        // The user-level agent can then reopen this exact app after a click,
        // without relying on a globally registered URL scheme.
        app_command: {
            #[cfg(target_os = "linux")]
            { crate::linux_notification_agent::persistent_app_command()? }
            #[cfg(not(target_os = "linux"))]
            { std::env::current_exe().ok().filter(|path| path.is_absolute())
                .map(|path| path.to_string_lossy().into_owned()) }
        },
        // The agent observes this state on a secure-stream heartbeat or a
        // reconnect.
        // Linux is additionally stopped by its user service; Windows is stopped
        // on the next per-user start and never needs administrator privileges.
        enabled: installation.background_mode_enabled,
    };
    write_json(
        path,
        &config,
        "Background notification agent config could not be saved.",
    )
}

fn write_json<T: Serialize>(path: PathBuf, value: &T, message: &str) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Desktop notification directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory).map_err(|_| message.to_owned())?;
    let content = serde_json::to_vec_pretty(value).map_err(|_| message.to_owned())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary).map_err(|_| message.to_owned())?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|_| message.to_owned())?;
    drop(file);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    return crate::notification_inbox::commit_replacement(&temporary, &path)
        .map_err(|_| message.to_owned());
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    fs::rename(temporary, path).map_err(|_| message.to_owned())
}

fn notification_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(NOTIFICATION_DIR).join(file_name))
        .map_err(|_| "Desktop notification directory is unavailable.".to_owned())
}

fn pending_open_path(app: &AppHandle) -> Result<PathBuf, String> {
    notification_path(app, PENDING_OPEN_FILE)
}

fn validate_permission(value: &str) -> Result<(), String> {
    if matches!(value, "authorized" | "denied" | "provisional" | "unknown") {
        Ok(())
    } else {
        Err("Desktop notification permission status is invalid.".to_owned())
    }
}

fn provider_status(installation: &NotificationInstallation) -> String {
    if !installation.enabled {
        return "disabled".to_owned();
    }
    match installation.provider.as_str() {
        "linux-agent" | "windows-agent" if installation.background_mode_enabled => {
            "ready".to_owned()
        }
        "linux-agent" | "windows-agent" => "local-fallback".to_owned(),
        "apns" if installation.provider_status.starts_with("apns-") => installation.provider_status.clone(),
        "apns" if is_apns_device_token(&installation.endpoint) => "ready".to_owned(),
        "tauri-local" => "local-fallback".to_owned(),
        _ => "not-configured".to_owned(),
    }
}

fn gateway_current(installation: &NotificationInstallation, current_time: u64) -> bool {
    crate::apns_registration::gateway_current(&installation.gateway_status,
        installation.gateway_lease_expires_at, installation.gateway_checked_at, current_time)
}

fn delivery(installation: &NotificationInstallation) -> String {
    if !installation.enabled {
        return "disabled".to_owned();
    }
    if !gateway_current(installation, now()) {
        return "local-while-open".to_owned();
    }
    match installation.provider_status.as_str() {
        "ready" => match installation.provider.as_str() {
            "apns" => "closed-app-apns",
            "windows-agent" => "background-windows-agent",
            "linux-agent" => "background-linux-agent",
            _ => "local-while-open",
        },
        _ => "local-while-open",
    }
    .to_owned()
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn provider() -> &'static str {
    if cfg!(target_os = "macos") {
        "apns"
    } else if cfg!(target_os = "windows") {
        "windows-agent"
    } else if cfg!(target_os = "linux") {
        "linux-agent"
    } else {
        "tauri-local"
    }
}

fn default_endpoint() -> String {
    std::env::var("TEX8_DESKTOP_NOTIFICATION_ENDPOINT").unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn refresh_platform_endpoint(installation: &mut NotificationInstallation) {
    if !installation.enabled {
        installation.provider_status = "disabled".to_owned();
        return;
    }
    let status = macos_apns_status().unwrap_or_else(|| "not-requested".to_owned());
    if let Some(token) = macos_apns_device_token().filter(|_| status == "registered") {
        installation.endpoint = token;
        installation.provider_status = "ready".to_owned();
    } else if installation.enabled {
        installation.provider_status = format!("apns-{}", crate::apns_registration::status_kind(&status));
    }
}

#[cfg(not(target_os = "macos"))]
fn refresh_platform_endpoint(_: &mut NotificationInstallation) {}

#[cfg(target_os = "macos")]
fn request_macos_apns_registration() {
    unsafe {
        let _ = tex8_desktop_apns_register();
    }
}

#[cfg(not(target_os = "macos"))]
fn request_macos_apns_registration() {}

#[cfg(target_os = "macos")]
async fn resume_macos_apns_registration(
    app: &AppHandle,
    expected: &NotificationInstallation,
    installation: &mut NotificationInstallation,
    retry: bool,
) -> Result<(), String> {
    use crate::apns_registration::resume_allowed;
    if !resume_allowed(installation.enabled, &installation.permission_status) { return Ok(()); }
    ensure_preference_current(app, expected)?;
    // One click may replace a failed/expired attempt once. Never start a
    // second 45-second round when that fresh attempt times out.
    let resumed = unsafe { tex8_desktop_apns_resume(if retry { 1 } else { 0 }) };
    if resumed != 0 {
        crate::diagnostics::record(app, "notifications.apns-resume", &[
            ("phase", if retry { "explicit-test" } else { "resume" }.to_owned()),
            ("result", if resumed == 1 { "started" } else { "existing-attempt" }.to_owned())]);
    }
    let result = wait_for_macos_apns_callback(app, expected, installation).await;
    if resumed != 0 {
        let _ = app.emit("mfw-notification-registration-changed", serde_json::json!({
            "result": if result.is_ok() { "completed" } else { "unavailable" }
        }));
    }
    result
}

#[cfg(not(target_os = "macos"))]
async fn resume_macos_apns_registration(
    _: &AppHandle, _: &NotificationInstallation, _: &mut NotificationInstallation, _: bool,
) -> Result<(), String> { Ok(()) }

fn ensure_preference_current(app: &AppHandle, expected: &NotificationInstallation) -> Result<(), String> {
    let _record = installation_lock()?;
    let current = load(app)?.ok_or_else(|| PREFERENCE_CHANGED.to_owned())?;
    if preference_current(expected, &current) { Ok(()) } else { Err(PREFERENCE_CHANGED.to_owned()) }
}

#[cfg(target_os = "macos")]
async fn wait_for_macos_apns_callback(
    app: &AppHandle,
    expected: &NotificationInstallation,
    installation: &mut NotificationInstallation,
) -> Result<(), String> {
    use crate::apns_registration::{wait_for_callback, Progress};
    let started = std::time::Instant::now();
    let mut previous_status: Option<String> = None;
    let outcome = wait_for_callback(
        || {
            let status = macos_apns_status().unwrap_or_else(|| "not-requested".to_owned());
            if previous_status.as_deref() != Some(status.as_str()) {
                let kind = crate::apns_registration::status_kind(&status);
                let mut fields = vec![("phase", kind.to_owned()), ("providerStatus", kind.to_owned())];
                if let Some((domain, code)) = crate::apns_registration::error_metadata(&status) {
                    fields.push(("nsErrorDomain", domain.to_owned()));
                    fields.push(("nsErrorCode", code.to_string()));
                }
                crate::diagnostics::record(app, "notifications.apns-registration", &fields);
                previous_status = Some(status.clone());
            }
            (
                status,
                macos_apns_device_token().is_some(),
                // Lifetime belongs to the native attempt, not this observer.
                unsafe { tex8_desktop_apns_attempt_elapsed_millis() }.into(),
            )
        },
        || tokio::time::sleep(std::time::Duration::from_millis(200)),
    )
    .await;
    ensure_preference_current(app, expected)?;
    let failure_code = match outcome {
        Progress::Denied => Some("apns-authorization-denied"),
        Progress::AuthorizationRequired => Some("apns-authorization-required"),
        Progress::AuthorizationError => Some("apns-authorization-error"),
        Progress::RegistrationError => Some("apns-registration-error"),
        Progress::TimedOut => Some("apns-registration-timeout"),
        Progress::Failed => Some("apns-registration-failed"),
        _ => None,
    };
    if let Some(code) = failure_code {
        crate::diagnostics::record(app, "notifications.apns-registration-stopped", &[
            ("safeErrorCode", code.to_owned()), ("elapsedMs", started.elapsed().as_millis().to_string())]);
        installation.provider_status = code.to_owned();
        installation.updated_at = now();
        write_installation_if_current(app, expected, installation)?;
    }
    match outcome {
        Progress::NotRequested | Progress::Ready => Ok(()),
        Progress::Pending => unreachable!("wait_for_callback returns only terminal states"),
        Progress::Denied => {
            installation.permission_status = "denied".to_owned();
            installation.enabled = false;
            installation.preference_generation = next_preference_generation(expected.preference_generation)?;
            installation.provider_status = "apns-authorization-denied".to_owned();
            installation.updated_at = now();
            write_installation_if_current(app, expected, installation)?;
            Err("apns-authorization-denied: Allow notifications for Monero Fast Wallet in macOS System Settings, then try again.".to_owned())
        }
        Progress::AuthorizationError => Err("apns-authorization-error: macOS could not complete notification authorization. Try again.".to_owned()),
        Progress::AuthorizationRequired => Err("apns-authorization-required: Enable notifications for this device before testing push notifications.".to_owned()),
        Progress::RegistrationError => Err("apns-registration-error: macOS could not register remote notifications. Try again.".to_owned()),
        Progress::BundleRequired => Err("Open the installed Monero Fast Wallet.app to enable remote notifications.".to_owned()),
        Progress::TimedOut => Err("apns-registration-timeout: macOS notification registration is still pending. Try again.".to_owned()),
        Progress::Failed => Err("apns-registration-failed: macOS could not register remote notifications. Try again.".to_owned()),
    }
}

#[cfg(target_os = "macos")]
fn macos_apns_device_token() -> Option<String> {
    let value = unsafe { c_string(tex8_desktop_apns_device_token()) }?;
    if is_apns_device_token(&value) {
        Some(value)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_apns_status() -> Option<String> {
    unsafe { c_string(tex8_desktop_apns_status()) }
}

#[cfg(target_os = "macos")]
unsafe fn c_string(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    CStr::from_ptr(pointer)
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn is_apns_device_token(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 256
        && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn notification_service_url() -> String {
    let gateway = option_env!("TEX8_FAST_WALLET_GATEWAY_ORIGIN")
        .unwrap_or("")
        .trim_end_matches('/');
    if private_service_origin(gateway) {
        format!("{gateway}/api/v1/notifications")
    } else {
        // The feature gate prevents enrollment in an unconfigured release.
        // Keeping a syntactically valid fail-closed value lets the disabled
        // background-agent config remain parseable during local development.
        "https://invalid.invalid/api/v1/notifications".to_owned()
    }
}

fn gateway_origin() -> Result<String, String> {
    let gateway = option_env!("TEX8_FAST_WALLET_GATEWAY_ORIGIN")
        .unwrap_or("")
        .trim_end_matches('/');
    if private_service_origin(gateway) {
        Ok(gateway.to_owned())
    } else {
        Err("The desktop notification service is not configured in this build.".to_owned())
    }
}

fn private_service_origin(value: &str) -> bool {
    if value.starts_with("https://") {
        return true;
    }
    let Some(host) = value.strip_prefix("http://") else {
        return false;
    };
    host.len() == 62
        && host.ends_with(".onion")
        && host[..56]
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
}

fn desktop_http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(12))
        .proxy(crate::tor_transport::proxy()?)
        .build()
        .map_err(|_| "The desktop notification client could not be created.".to_owned())
}

fn random_hex_16() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| {
        "Secure randomness is unavailable; notification setup was cancelled.".to_owned()
    })?;
    Ok(bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn random_hex_32() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| {
        "Secure randomness is unavailable; notification setup was cancelled.".to_owned()
    })?;
    Ok(bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{
        delivery, provider_status, valid_open_event, NotificationEvent, NotificationInstallation,
    };

    fn installation(provider: &str, endpoint: &str, background: bool) -> NotificationInstallation {
        NotificationInstallation {
            version: 1,
            tenant_id: "tex8".to_owned(),
            shop_id: "monero-wallet".to_owned(),
            app_id: "monero-wallet-desktop".to_owned(),
            installation_id: "mwp_desktop_test".to_owned(),
            platform: "linux".to_owned(),
            provider: provider.to_owned(),
            endpoint: endpoint.to_owned(),
            permission_status: "authorized".to_owned(),
            locale: None,
            app_version: None,
            enabled: true,
            preference_generation: 0,
            background_mode_enabled: background,
            provider_status: "disabled".to_owned(),
            gateway_status: "unregistered".to_owned(),
            gateway_generation: None,
            provider_token_hash: None,
            gateway_lease_expires_at: None,
            gateway_checked_at: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn background_agents_are_required_for_closed_app_delivery() {
        let mut local = installation("linux-agent", "", false);
        local.provider_status = provider_status(&local);
        assert_eq!(local.provider_status, "local-fallback");
        assert_eq!(delivery(&local), "local-while-open");

        let mut background = installation("linux-agent", "", true);
        background.provider_status = provider_status(&background);
        assert_eq!(background.provider_status, "ready");
        assert_eq!(delivery(&background), "local-while-open");
        background.gateway_status = "active".to_owned();
        background.gateway_lease_expires_at = Some(super::now() + 60);
        background.gateway_checked_at = Some(super::now());
        assert_eq!(delivery(&background), "background-linux-agent");

        let mut windows = installation("windows-agent", "", true);
        windows.platform = "windows".to_owned();
        windows.provider_status = provider_status(&windows);
        assert_eq!(windows.provider_status, "ready");
        windows.gateway_status = "active".to_owned();
        windows.gateway_lease_expires_at = Some(super::now() + 60);
        windows.gateway_checked_at = Some(super::now());
        assert_eq!(delivery(&windows), "background-windows-agent");
    }

    #[test]
    fn apns_requires_a_provider_endpoint() {
        let mut apns = installation("apns", "", false);
        apns.provider_status = provider_status(&apns);
        assert_eq!(apns.provider_status, "not-configured");
    }

    #[test]
    fn vanity_open_requires_an_explicit_open_and_strict_deep_link() {
        let mut event = NotificationEvent {
            id: format!("evt_{}", "a".repeat(64)),
            category: "monero.fast_wallet.vanity".to_owned(),
            deep_link: "mfw://vanity/order/550e8400-e29b-41d4-a716-446655440000".to_owned(),
            received_at: "1".to_owned(),
            opened: true,
        };
        assert!(valid_open_event(&event));
        event.opened = false;
        assert!(!valid_open_event(&event));
        event.opened = true;
        event.deep_link = "https://example.invalid".to_owned();
        assert!(!valid_open_event(&event));
    }

    #[test]
    fn incoming_open_keeps_existing_opaque_id_formats() {
        for id in [
            format!("evt_{}", "b".repeat(64)),
            format!("sig_{}", "c".repeat(64)),
            format!("fwpush_{}", "d".repeat(32)),
        ] {
            assert!(valid_open_event(&NotificationEvent {
                id,
                category: "monero.fast_wallet.incoming".to_owned(),
                deep_link: "tex8://notification/incoming".to_owned(),
                received_at: "1".to_owned(),
                opened: true,
            }));
        }
    }
}


const TEST_PUSH_STATE_FILE: &str = "push-test-state.json";
static TEST_PUSH_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static TEST_PUSH_REQUEST_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestPushReceipt {
    pub accepted: bool,
    pub event_id: String,
    pub scheduled_at: u64,
    pub deliver_after: u64,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPushState {
    receipt: Option<TestPushReceipt>,
    #[serde(default)]
    received: Vec<TestPushReceived>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPushReceived { event_id: String, received_at: u64 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestPushStatus {
    pub platform: String,
    pub available: bool,
    pub reason: String,
    pub phase: String,
    pub receipt: Option<TestPushReceipt>,
    pub received_at: Option<u64>,
    pub background_agent_status: Option<String>,
    pub permission_settings_available: bool,
}
fn read_test_push_state(app: &AppHandle) -> Result<TestPushState, String> {
    let path = notification_path(app, TEST_PUSH_STATE_FILE)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) if bytes.len() <= 32 * 1024 => bytes,
        Ok(_) => return Err("Push test state exceeds its limit.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(TestPushState::default()),
        Err(_) => return Err("Push test state is unavailable.".to_owned()),
    };
    serde_json::from_slice(&bytes).map_err(|_| "Push test state is invalid.".to_owned())
}
fn test_setup_gate(app: &AppHandle) -> Result<String, String> {
    let wallets = crate::fast_wallet::list(app)?;
    let has_fast = !wallets.is_empty();
    let has_alerts = wallets.iter().any(|wallet| crate::notification_test::alerts_ready(
        wallet.notifications_enabled, &wallet.alert_status, wallet.worker_receipt_verified,
        wallet.assignment_handle.is_some(), wallet.assignment_expires_at, now()));
    let status = status(app)?;
    let background_agent_ready = status.background_agent_status.as_deref()
        .is_none_or(|status| status == "connected");
    let installation = status.installation;
    let provider_ready = installation.provider_status == "ready" && match installation.provider.as_str() {
        "apns" => is_apns_device_token(&installation.endpoint),
        "windows-agent" | "linux-agent" => installation.background_mode_enabled,
        _ => false,
    };
    let gate = crate::notification_test::setup_gate(has_fast, has_alerts,
        installation.enabled && installation.permission_status == "authorized", provider_ready,
        installation.gateway_status == "active" && installation.gateway_lease_expires_at.is_some_and(|expires| expires > now()));
    Ok(if gate == "ready" && !background_agent_ready { "agent-required" } else { gate }.to_owned())
}
#[cfg(target_os = "macos")]
async fn macos_permission_settings_available(app: &AppHandle) -> bool {
    let query = unsafe { tex8_desktop_apns_refresh_authorization() };
    let started = std::time::Instant::now();
    let observed = loop {
        let status = unsafe { c_string(tex8_desktop_apns_authorization_status(query)) }
            .unwrap_or_else(|| "unknown".to_owned());
        if status != "checking" { break status; }
        if started.elapsed() >= std::time::Duration::from_millis(1000) { break "unknown".to_owned(); }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    };
    crate::diagnostics::record(app, "notifications.permission-status", &[
        ("phase", "os-settings".to_owned()), ("result", observed.clone())]);
    crate::apns_registration::permission_settings_available(&observed)
}

#[cfg(not(target_os = "macos"))]
async fn macos_permission_settings_available(_: &AppHandle) -> bool { false }

pub async fn open_notification_settings(app: &AppHandle) -> Result<(), String> {
    open_macos_settings(app, false).await
}

pub async fn open_focus_settings(app: &AppHandle) -> Result<(), String> {
    open_macos_settings(app, true).await
}

async fn open_macos_settings(app: &AppHandle, focus: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Fixed OS-owned route; no shell, arbitrary URLs or preference writes.
        let opened = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("/usr/bin/open")
                .arg(crate::apns_registration::fixed_settings_url(focus))
                .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                .status().is_ok_and(|status| status.success())
        }).await.unwrap_or(false);
        crate::diagnostics::record(app, "notifications.open-settings", &[
            ("phase", if focus { "focus-settings" } else { "notification-settings" }.to_owned()),
            ("result", if opened { "opened" } else { "failed" }.to_owned())]);
        if opened { Ok(()) } else { Err("Notification settings could not be opened.".to_owned()) }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, focus); Err("Notification settings are only available on macOS.".to_owned()) }
}

pub async fn test_push_status(app: &AppHandle) -> Result<TestPushStatus, String> {
    let permission_settings_available = macos_permission_settings_available(app).await;
    let reason = if permission_settings_available { "permission-required".to_owned() } else { test_setup_gate(app)? };
    let _lock = TEST_PUSH_STATE_LOCK.lock().map_err(|_| "Push test state is busy.".to_owned())?;
    let state = read_test_push_state(app)?;
    let received = state.receipt.as_ref().and_then(|receipt|
        state.received.iter().find(|event| event.event_id == receipt.event_id));
    Ok(TestPushStatus {
        platform: platform().to_owned(),
        background_agent_status: status(app)?.background_agent_status,
        available: reason == "ready", reason,
        phase: crate::notification_test::phase(state.receipt.as_ref().map(|receipt| receipt.event_id.as_str()),
            received.map(|event| event.event_id.as_str()), state.receipt.as_ref().map_or(0, |receipt| receipt.deliver_after), now()).to_owned(),
        received_at: received.map(|event| event.received_at), receipt: state.receipt,
        permission_settings_available,
    })
}
pub async fn request_test_push(app: &AppHandle) -> Result<TestPushStatus, String> {
    use std::sync::atomic::Ordering;
    if TEST_PUSH_REQUEST_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("A push test request is already running.".to_owned());
    }
    struct RequestGuard;
    impl Drop for RequestGuard { fn drop(&mut self) { TEST_PUSH_REQUEST_RUNNING.store(false, Ordering::SeqCst); } }
    let _request = RequestGuard;
    let _registration = REGISTRATION_LOCK.lock().await;
    let preflight = test_push_status(app).await?;
    let mut gate = preflight.reason;
    crate::diagnostics::record(app, "notifications.test-push-preflight", &[
        ("phase", "preflight".to_owned()), ("reason", gate.clone())]);
    if matches!(gate.as_str(), "provider-required" | "gateway-required" | "agent-required") {
        if let Err(error) = reconcile_gateway_locked(app, true).await {
            crate::diagnostics::record(app, "notifications.test-push-resume-stopped", &[
                ("phase", "resume".to_owned()), ("safeErrorCode", registration_error_code(&error).to_owned())]);
            return Err(error);
        }
        gate = test_setup_gate(app)?;
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    if gate == "agent-required" {
        let expected = load_or_create(app)?;
        let started = std::time::Instant::now();
        while gate == "agent-required" && started.elapsed() < std::time::Duration::from_secs(45) {
            ensure_preference_current(app, &expected)?;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            gate = test_setup_gate(app)?;
        }
        crate::diagnostics::record(app, "notifications.agent-readiness", &[
            ("phase", "waiting-for-agent".to_owned()), ("reason", gate.clone()),
            ("elapsedMs", started.elapsed().as_millis().to_string())]);
    }
    if gate != "ready" {
        crate::diagnostics::record(app, "notifications.test-push-gated", &[
            ("phase", "gated".to_owned()), ("reason", gate.clone())]);
        return Err(if gate == "agent-required" {
            "push-test-agent-required: Background notification helper is not connected.".to_owned()
        } else { format!("Push test setup is incomplete: {gate}") });
    }
    if preflight.phase == "scheduled" {
        return Err("A server push test is already awaiting receipt.".to_owned());
    }
    let installation = status(app)?.installation;
    ensure_preference_current(app, &installation)?;
    let auth = zeroize::Zeroizing::new(
        crate::secure_store::load_notification_installation_auth(&installation.installation_id)?
            .ok_or_else(|| "The notification installation credential is missing.".to_owned())?,
    );
    crate::diagnostics::record(app, "notifications.test-push-requested", &[("phase", "requesting".to_owned())]);
    let result = desktop_http_client()?.post(format!("{}/api/v1/installations/test-push", gateway_origin()?))
        .header(header::ACCEPT, "application/json")
        .header("x-fast-wallet-installation-id", &installation.installation_id)
        .header("x-fast-wallet-installation-auth", auth.as_str())
        .json(&serde_json::json!({})).send().await;
    let mut response = result.map_err(|_| "The server push test request could not be sent.".to_owned())?;
    let response_status = response.status();
    if response_status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        crate::diagnostics::record(app, "notifications.test-push-rejected", &[
            ("phase", "rate-limited".to_owned()), ("httpStatus", "429".to_owned()),
            ("safeErrorCode", "push-test-rate-limited".to_owned())]);
        return Err("push-test-rate-limited".to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "The push test receipt could not be read.".to_owned())? {
        if bytes.len() + chunk.len() > 8192 { return Err("The push test receipt exceeds its limit.".to_owned()); }
        bytes.extend_from_slice(&chunk);
    }
    if response_status != reqwest::StatusCode::ACCEPTED {
        crate::diagnostics::record(app, "notifications.test-push-rejected", &[("phase", "rejected".to_owned())]);
        let code = serde_json::from_slice::<serde_json::Value>(&bytes).ok()
            .and_then(|value| value.get("error").and_then(serde_json::Value::as_str).map(str::to_owned));
        return Err(match code.as_deref() {
            Some("self_test_worker_unsupported") => "push-test-worker-unsupported",
            Some("self_test_requires_fast_wallet") => "push-test-fast-wallet-required",
            Some("self_test_provider_required") => "push-test-provider-required",
            Some("self_test_unavailable") => "push-test-unavailable",
            _ => "The server did not accept the push test. Check Fast Wallet alerts and notification setup.",
        }.to_owned());
    }
    let receipt: TestPushReceipt = serde_json::from_slice(&bytes).map_err(|_| "The server push test receipt is invalid.".to_owned())?;
    if !crate::notification_test::valid_schedule(receipt.accepted, &receipt.event_id, receipt.scheduled_at, receipt.deliver_after, now()) {
        return Err("The server push test receipt is invalid.".to_owned());
    }
    {
        let _lock = TEST_PUSH_STATE_LOCK.lock().map_err(|_| "Push test state is busy.".to_owned())?;
        let mut state = read_test_push_state(app)?;
        state.receipt = Some(receipt.clone());
        write_json(notification_path(app, TEST_PUSH_STATE_FILE)?, &state, "Push test receipt could not be saved.")?;
    }
    crate::diagnostics::record(app, "notifications.test-push-scheduled", &[
        ("pushTestEventId", receipt.event_id), ("scheduledAt", receipt.scheduled_at.to_string()),
        ("deliverAfter", receipt.deliver_after.to_string()), ("phase", "scheduled".to_owned())]);
    test_push_status(app).await
}

fn registration_error_code(error: &str) -> &'static str {
    if error == PREFERENCE_CHANGED { return "notification-preference-changed"; }
    match error.split(':').next().unwrap_or_default() {
        "apns-authorization-denied" => "apns-authorization-denied",
        "apns-authorization-required" => "apns-authorization-required",
        "apns-authorization-error" => "apns-authorization-error",
        "apns-registration-error" => "apns-registration-error",
        "apns-registration-timeout" => "apns-registration-timeout",
        "apns-registration-failed" => "apns-registration-failed",
        _ => "notification-registration-unavailable",
    }
}
fn valid_received_event(event: &NotificationEvent) -> bool {
    let mut opened = event.clone(); opened.opened = true;
    crate::notification_test::opaque_event_id(&event.id) && valid_open_event(&opened)
}
fn record_notification_received(app: &AppHandle, event: &NotificationEvent) -> Result<(), String> {
    if event.category != crate::notification_test::CATEGORY { return Ok(()); }
    let _lock = TEST_PUSH_STATE_LOCK.lock().map_err(|_| "Push test state is busy.".to_owned())?;
    let mut state = read_test_push_state(app)?;
    if state.received.iter().any(|received| received.event_id == event.id) { return Ok(()); }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let received_at = crate::notification_inbox::received_timestamp(&event.received_at, now());
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let received_at = now();
    state.received.push(TestPushReceived { event_id: event.id.clone(), received_at });
    if state.received.len() > 32 { state.received.remove(0); }
    write_json(notification_path(app, TEST_PUSH_STATE_FILE)?, &state, "Push test receipt could not be saved.")?;
    crate::diagnostics::record(app, "notifications.test-push-received", &[
        ("pushTestEventId", event.id.clone()), ("opened", event.opened.to_string()), ("phase", "received".to_owned())]);
    Ok(())
}
pub fn consume_pending_events(app: &AppHandle) -> Result<Vec<NotificationEvent>, String> {
    let mut events = Vec::new();
    #[cfg(target_os = "macos")]
    for _ in 0..64 {
        let raw = unsafe { c_string(tex8_desktop_apns_take_received_event()) }.filter(|raw| !raw.trim().is_empty());
        let Some(raw) = raw else { break; };
        if let Ok(event) = serde_json::from_str::<NotificationEvent>(&raw) {
            if valid_received_event(&event) { events.push(event); }
        }
    }
    if let Some(opened) = consume_pending_open(app)? { events.push(opened); }
    let directory = notification_path(app, "received-events")?;
    if let Ok(files) = fs::read_dir(directory) {
        for file in files.flatten().take(64) {
            let path = file.path();
            if path.extension().is_none_or(|extension| extension != "json") { continue; }
            if let Ok(metadata) = fs::symlink_metadata(&path) {
                if !metadata.is_file() || metadata.len() > 4096 { continue; }
            } else { continue; }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if let Ok(event) = serde_json::from_slice::<NotificationEvent>(&bytes) {
                if valid_received_event(&event) {
                    crate::notification_inbox::persist_then_remove(&path, || record_notification_received(app, &event))?;
                    events.push(event);
                    continue;
                }
            }
            let _ = fs::remove_file(path);
        }
    }
    for event in &events { record_notification_received(app, event)?; }
    Ok(events)
}

#[cfg(test)]
mod installation_migration_tests {
    use super::*;

    fn legacy() -> NotificationInstallation {
        let mut value = default_installation().unwrap();
        value.version = 2;
        value.platform = "windows".into();
        value.provider = "wns".into();
        value.endpoint = "https://synthetic.invalid/old-wns-channel".into();
        value.enabled = true;
        value.permission_status = "authorized".into();
        value.background_mode_enabled = false;
        value.gateway_status = "active".into();
        value.gateway_generation = Some(10);
        value.provider_token_hash = Some("synthetic-old-hash".into());
        value.gateway_lease_expires_at = Some(100);
        value.gateway_checked_at = Some(90);
        value
    }

    #[test]
    fn legacy_windows_wns_keeps_consent_but_clears_old_channel_and_lease() {
        let old = legacy();
        let id = old.installation_id.clone();
        let value = normalize_loaded_installation(old, "windows", "windows-agent", String::new).unwrap();
        assert_eq!(value.installation_id, id);
        assert!(value.enabled);
        assert_eq!(value.permission_status, "authorized");
        assert!(!value.background_mode_enabled);
        assert_eq!(value.provider, "windows-agent");
        assert!(value.endpoint.is_empty());
        assert_eq!(value.gateway_status, "unregistered");
        assert_eq!(value.gateway_generation, None);
        assert_eq!(value.provider_token_hash, None);
        assert_eq!(value.gateway_lease_expires_at, None);
        assert_eq!(value.gateway_checked_at, None);
    }

    #[test]
    fn legacy_wns_is_not_accepted_on_other_platforms_or_newer_contracts() {
        assert!(normalize_loaded_installation(legacy(), "macos", "apns", String::new).is_err());
        let mut value = legacy();
        value.version = CONTRACT_VERSION;
        assert!(normalize_loaded_installation(value, "windows", "windows-agent", String::new).is_err());
        let mut value = legacy();
        value.app_id = "another-app".into();
        assert!(normalize_loaded_installation(value, "windows", "windows-agent", String::new).is_err());
    }
}
