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
use tauri::{AppHandle, Manager};

const NOTIFICATION_DIR: &str = "notifications";
const INSTALLATION_FILE: &str = "desktop-installation.json";
const BACKGROUND_AGENT_FILE: &str = "background-agent.json";
const PENDING_OPEN_FILE: &str = "pending-open-event.json";
const CONTRACT_VERSION: u8 = 5;

// These symbols are implemented by the AppKit bridge.  Keep the declaration
// macOS uses APNs. Windows and Linux use the private background agent and
// must not try to link an APNs implementation.
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn tex8_desktop_apns_register() -> c_int;
    fn tex8_desktop_apns_device_token() -> *const c_char;
    fn tex8_desktop_apns_status() -> *const c_char;
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
    let previous_endpoint = installation.endpoint.clone();
    refresh_platform_endpoint(&mut installation);
    if installation.endpoint != previous_endpoint {
        installation.updated_at = now();
        write_installation(app, &installation)?;
    }
    status_for_installation(app, installation)
}

pub fn request_installation(
    app: &AppHandle,
    input: RequestNotificationInstallationInput,
) -> Result<NotificationInstallationStatus, String> {
    validate_permission(&input.permission_status)?;
    let now = now();
    let mut installation = load_or_create(app)?;
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
    let mut installation = load_or_create(app)?;
    refresh_platform_endpoint(&mut installation);
    if !installation.enabled {
        return status_for_installation(app, installation);
    }
    let (provider, token) = match installation.provider.as_str() {
        "apns" if is_apns_device_token(&installation.endpoint) => {
            ("apns", installation.endpoint.trim())
        }
        "apns" => {
            installation.gateway_status = "provider-pending".to_owned();
            installation.gateway_checked_at = Some(now());
            write_installation(app, &installation)?;
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
                                write_installation(app, &installation)?;
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
            write_installation(app, &installation)?;
            return Err("The desktop notification service rejected this installation.".to_owned());
        }
        Err(_) => {
            installation.gateway_status = "needs-refresh".to_owned();
            installation.gateway_checked_at = Some(current_time);
            write_installation(app, &installation)?;
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
    write_installation(app, &installation)?;
    status_for_installation(app, installation)
}

pub fn disable_installation(app: &AppHandle) -> Result<NotificationInstallationStatus, String> {
    let mut installation = load_or_create(app)?;
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
    let path = pending_open_path(app)?;
    let raw = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Pending notification event could not be read.".to_owned()),
    };
    let event = serde_json::from_str::<NotificationEvent>(&raw)
        .map_err(|_| "Pending notification event is invalid.".to_owned())?;
    let _ = fs::remove_file(path);
    Ok(Some(event))
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
    Ok(NotificationInstallationStatus {
        delivery: delivery(&installation),
        // APNs owns closed-app delivery on macOS. The optional local agent is
        // intentionally a Windows/Linux feature until a macOS fallback exists.
        background_mode_supported: matches!(platform(), "windows" | "linux"),
        background_agent_config_path: background_agent_config_path(app)?,
        installation,
    })
}

fn load_or_create(app: &AppHandle) -> Result<NotificationInstallation, String> {
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
    let mut installation = serde_json::from_str::<NotificationInstallation>(&raw)
        .map_err(|_| "Desktop notification installation is invalid.".to_owned())?;
    if !matches!(installation.version, 1 | 2 | 3 | 4 | CONTRACT_VERSION)
        || installation.installation_id.is_empty()
        || installation.installation_id.len() > 80
        || !matches!(
            installation.provider.as_str(),
            "apns" | "windows-agent" | "linux-agent" | "tauri-local"
        )
    {
        return Err("Desktop notification installation is invalid.".to_owned());
    }
    installation.platform = platform().to_owned();
    installation.provider = provider().to_owned();
    if installation.endpoint.trim().is_empty() {
        installation.endpoint = default_endpoint();
    }
    Ok(Some(installation))
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
        app_command: std::env::current_exe()
            .ok()
            .filter(|path| path.is_absolute())
            .map(|path| path.to_string_lossy().into_owned()),
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
        "apns" if is_apns_device_token(&installation.endpoint) => "ready".to_owned(),
        "tauri-local" => "local-fallback".to_owned(),
        _ => "not-configured".to_owned(),
    }
}

fn delivery(installation: &NotificationInstallation) -> String {
    if !installation.enabled {
        return "disabled".to_owned();
    }
    if installation.gateway_status != "active" {
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
    if let Some(token) = macos_apns_device_token() {
        installation.endpoint = token;
        installation.provider_status = "ready".to_owned();
    } else if installation.enabled {
        let status = macos_apns_status().unwrap_or_else(|| "not-registered".to_owned());
        installation.provider_status = format!("apns-{status}");
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
    if gateway.starts_with("https://") {
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
    if gateway.starts_with("https://") {
        Ok(gateway.to_owned())
    } else {
        Err("The desktop notification service is not configured in this build.".to_owned())
    }
}

fn desktop_http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(12))
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
    use super::{delivery, provider_status, NotificationInstallation};

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
        assert_eq!(delivery(&background), "background-linux-agent");

        let mut windows = installation("windows-agent", "", true);
        windows.platform = "windows".to_owned();
        windows.provider_status = provider_status(&windows);
        assert_eq!(windows.provider_status, "ready");
        windows.gateway_status = "active".to_owned();
        assert_eq!(delivery(&windows), "background-windows-agent");
    }

    #[test]
    fn apns_requires_a_provider_endpoint() {
        let mut apns = installation("apns", "", false);
        apns.provider_status = provider_status(&apns);
        assert_eq!(apns.provider_status, "not-configured");
    }
}
