use serde::{Deserialize, Serialize};
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
const LINUX_AGENT_FILE: &str = "linux-agent.json";
const PENDING_OPEN_FILE: &str = "pending-open-event.json";
const CONTRACT_VERSION: u8 = 2;

// These symbols are implemented by the AppKit bridge.  Keep the declaration
// macOS-only: Windows uses WNS and must not try to link an APNs implementation.
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
    pub linux_agent_config_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinuxAgentConfig {
    version: u8,
    installation_id: String,
    platform: String,
    provider: String,
    service_url: String,
    poll_interval_ms: u64,
    app_command: Option<String>,
}

pub fn status(app: &AppHandle) -> Result<NotificationInstallationStatus, String> {
    let mut installation = load(app)?.unwrap_or_else(default_installation);
    let previous_endpoint = installation.endpoint.clone();
    refresh_platform_endpoint(&mut installation);
    if installation.endpoint != previous_endpoint {
        if installation.provider == "wns" {
            installation.gateway_status = "unregistered".to_owned();
        }
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
    let mut installation = load(app)?.unwrap_or_else(default_installation);
    installation.permission_status = input.permission_status;
    installation.locale = input.locale.filter(|value| !value.trim().is_empty());
    installation.app_version = input.app_version.filter(|value| !value.trim().is_empty());
    installation.enabled = installation.permission_status == "authorized";
    if installation.enabled && platform() == "macos" {
        request_macos_apns_registration();
    }
    refresh_platform_endpoint(&mut installation);
    if installation.enabled && installation.provider == "wns" {
        installation.gateway_status = match register_windows_wns_channel(&installation) {
            Ok(()) => "registered".to_owned(),
            Err(_) => "unavailable".to_owned(),
        };
    }
    installation.background_mode_enabled = installation.enabled
        && platform() == "linux"
        && input.background_mode_enabled.unwrap_or(false);
    installation.provider_status = provider_status(&installation);
    installation.updated_at = now;
    write_installation(app, &installation)?;
    write_or_remove_linux_agent_config(app, &installation)?;
    crate::linux_notification_agent::reconcile(app, installation.background_mode_enabled)?;
    status_for_installation(app, installation)
}

pub fn disable_installation(app: &AppHandle) -> Result<NotificationInstallationStatus, String> {
    let mut installation = load(app)?.unwrap_or_else(default_installation);
    installation.enabled = false;
    installation.background_mode_enabled = false;
    installation.permission_status = "denied".to_owned();
    installation.provider_status = provider_status(&installation);
    if installation.provider == "wns" {
        let _ = remove_windows_wns_channel(&installation);
        installation.gateway_status = "disabled".to_owned();
    }
    installation.updated_at = now();
    write_installation(app, &installation)?;
    write_or_remove_linux_agent_config(app, &installation)?;
    crate::linux_notification_agent::reconcile(app, false)?;
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

pub fn linux_agent_config_path(app: &AppHandle) -> Result<Option<String>, String> {
    if platform() != "linux" {
        return Ok(None);
    }
    Ok(Some(
        notification_path(app, LINUX_AGENT_FILE)?
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
        background_mode_supported: matches!(platform(), "macos" | "windows" | "linux"),
        linux_agent_config_path: linux_agent_config_path(app)?,
        installation,
    })
}

fn default_installation() -> NotificationInstallation {
    let timestamp = now();
    NotificationInstallation {
        version: CONTRACT_VERSION,
        tenant_id: "tex8".to_owned(),
        shop_id: "monero-wallet".to_owned(),
        app_id: "monero-wallet-desktop".to_owned(),
        installation_id: format!("mwp_desktop_{}", random_hex_16()),
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
        created_at: timestamp,
        updated_at: timestamp,
    }
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
    if !matches!(installation.version, 1 | CONTRACT_VERSION)
        || installation.installation_id.is_empty()
        || installation.installation_id.len() > 80
        || !matches!(
            installation.provider.as_str(),
            "apns" | "wns" | "linux-agent" | "tauri-local"
        )
    {
        return Err("Desktop notification installation is invalid.".to_owned());
    }
    if installation.version == 1 {
        installation.version = CONTRACT_VERSION;
        installation.gateway_status = "unregistered".to_owned();
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

fn write_or_remove_linux_agent_config(
    app: &AppHandle,
    installation: &NotificationInstallation,
) -> Result<(), String> {
    let path = notification_path(app, LINUX_AGENT_FILE)?;
    if platform() != "linux" || !installation.background_mode_enabled {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let config = LinuxAgentConfig {
        version: CONTRACT_VERSION,
        installation_id: installation.installation_id.clone(),
        platform: installation.platform.clone(),
        provider: installation.provider.clone(),
        service_url: notification_service_url(),
        poll_interval_ms: 45_000,
        // Persist the absolute application executable while the app is alive.
        // The user-level agent can then reopen this exact app after a click,
        // without relying on a globally registered URL scheme.
        app_command: std::env::current_exe()
            .ok()
            .filter(|path| path.is_absolute())
            .map(|path| path.to_string_lossy().into_owned()),
    };
    write_json(
        path,
        &config,
        "Linux notification agent config could not be saved.",
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
        "linux-agent" if installation.background_mode_enabled => "ready".to_owned(),
        "linux-agent" => "local-fallback".to_owned(),
        "apns" if is_apns_device_token(&installation.endpoint) => "ready".to_owned(),
        "wns"
            if !installation.endpoint.trim().is_empty()
                && installation.gateway_status == "registered" =>
        {
            "ready".to_owned()
        }
        "wns" if !installation.endpoint.trim().is_empty() => "gateway-unavailable".to_owned(),
        "tauri-local" => "local-fallback".to_owned(),
        _ => "not-configured".to_owned(),
    }
}

fn delivery(installation: &NotificationInstallation) -> String {
    if !installation.enabled {
        return "disabled".to_owned();
    }
    match installation.provider_status.as_str() {
        "ready" => match installation.provider.as_str() {
            "apns" => "closed-app-apns",
            "wns" => "closed-app-wns",
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
        "wns"
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

#[cfg(target_os = "windows")]
fn refresh_platform_endpoint(installation: &mut NotificationInstallation) {
    if !installation.enabled {
        return;
    }
    match windows_wns_channel_uri() {
        Ok(endpoint) => {
            installation.endpoint = endpoint;
            installation.provider_status = "unregistered".to_owned();
        }
        // An unpackaged development build has no Windows package identity and
        // is therefore deliberately *not* reported as WNS-ready. The UI can
        // still use its foreground local-notification fallback.
        Err(error) => {
            installation.endpoint.clear();
            installation.provider_status = "not-configured".to_owned();
            eprintln!("monero desktop WNS channel unavailable: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_wns_channel_uri() -> Result<String, String> {
    use windows::Networking::PushNotifications::PushNotificationChannelManager;

    let operation =
        PushNotificationChannelManager::CreatePushNotificationChannelForApplicationAsync()
            .map_err(|error| format!("channel request failed: {error}"))?;
    let channel = operation
        .get()
        .map_err(|error| format!("channel request failed: {error}"))?;
    let endpoint = channel
        .Uri()
        .map_err(|error| format!("channel URI is unavailable: {error}"))?
        .to_string();
    if endpoint.starts_with("https://") && endpoint.len() <= 4096 {
        Ok(endpoint)
    } else {
        Err("channel URI is invalid".to_owned())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    std::env::var("TEX8_NOTIFICATION_SERVICE_URL")
        .unwrap_or_else(|_| "https://xmr.tex8.com/api/v1/notifications".to_owned())
}

fn notification_registration_url() -> String {
    let base = notification_service_url();
    base.strip_suffix("/events")
        .map(|prefix| format!("{prefix}/installations"))
        .unwrap_or_else(|| format!("{}/installations", base.trim_end_matches('/')))
}

fn register_windows_wns_channel(installation: &NotificationInstallation) -> Result<(), String> {
    if installation.endpoint.trim().is_empty() {
        return Err("WNS channel is unavailable.".to_owned());
    }
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "Notification service is unavailable.".to_owned())?
        .post(notification_registration_url())
        .header(
            "x-fast-wallet-installation-id",
            &installation.installation_id,
        )
        .json(&serde_json::json!({
            "contractVersion": "monero-fast-wallet-push.v2",
            "installationId": installation.installation_id,
            "platform": "windows",
            "provider": "wns",
            "endpoint": installation.endpoint,
        }))
        .send()
        .map_err(|_| "Notification service is unavailable.".to_owned())?;
    if response.status().as_u16() == 202 {
        Ok(())
    } else {
        Err("Notification service rejected the WNS channel.".to_owned())
    }
}

fn remove_windows_wns_channel(installation: &NotificationInstallation) -> Result<(), String> {
    if installation.installation_id.trim().is_empty() {
        return Ok(());
    }
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "Notification service is unavailable.".to_owned())?
        .delete(notification_registration_url())
        .header(
            "x-fast-wallet-installation-id",
            &installation.installation_id,
        )
        .send()
        .map_err(|_| "Notification service is unavailable.".to_owned())?;
    if response.status().is_success() || response.status().as_u16() == 404 {
        Ok(())
    } else {
        Err("Notification service rejected the WNS removal.".to_owned())
    }
}

fn random_hex_16() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let fallback = now().to_le_bytes();
        bytes[..8].copy_from_slice(&fallback);
        bytes[8..].copy_from_slice(&fallback);
    }
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
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
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn linux_agent_is_required_for_closed_app_linux_delivery() {
        let mut local = installation("linux-agent", "", false);
        local.provider_status = provider_status(&local);
        assert_eq!(local.provider_status, "local-fallback");
        assert_eq!(delivery(&local), "local-while-open");

        let mut background = installation("linux-agent", "", true);
        background.provider_status = provider_status(&background);
        assert_eq!(background.provider_status, "ready");
        assert_eq!(delivery(&background), "background-linux-agent");
    }

    #[test]
    fn apns_and_wns_require_a_provider_endpoint() {
        let mut apns = installation("apns", "", false);
        apns.provider_status = provider_status(&apns);
        assert_eq!(apns.provider_status, "not-configured");

        let mut wns = installation("wns", "wns-channel", false);
        wns.provider_status = provider_status(&wns);
        assert_eq!(wns.provider_status, "gateway-unavailable");
        assert_eq!(delivery(&wns), "local-while-open");
        wns.gateway_status = "registered".to_owned();
        wns.provider_status = provider_status(&wns);
        assert_eq!(wns.provider_status, "ready");
        assert_eq!(delivery(&wns), "closed-app-wns");
    }
}
