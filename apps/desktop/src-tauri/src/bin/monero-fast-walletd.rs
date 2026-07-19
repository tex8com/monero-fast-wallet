//! Private, unprivileged background notification agent for Windows and Linux.
//!
//! It maintains one outbound WSS connection to the Tex8 notification gateway.
//! The gateway sends opaque event ids only; no wallet address, balance, amount,
//! transaction or key material ever reaches this process.

use serde::Deserialize;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::{
    collections::VecDeque,
    path::Path,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use std::{env, fs};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tungstenite::{client::IntoClientRequest, connect, http::HeaderValue, Message};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
struct AgentConfig {
    version: u8,
    installation_id: String,
    platform: String,
    provider: String,
    service_url: String,
    app_command: Option<String>,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
struct NotificationEvent {
    id: String,
    category: String,
    deep_link: String,
    #[serde(default)]
    received_at: String,
    #[serde(default)]
    opened: bool,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamEventMessage {
    #[serde(rename = "type")]
    message_type: String,
    event: NotificationEvent,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamAcknowledgement<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    event_id: &'a str,
}

fn enabled_by_default() -> bool {
    true
}

fn main() {
    if let Err(error) = run() {
        eprintln!("monero-fast-walletd: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let config_path = parse_config_path()?;
    let config = read_config(&config_path)?;
    validate_config(&config)?;
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = config;
        return Err("monero-fast-walletd is supported only on Windows and Linux".to_owned());
    }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    run_agent(config_path, config)
}

fn validate_config(config: &AgentConfig) -> Result<(), String> {
    // Version 4 replaces periodic polling with one authenticated WSS stream.
    // The desktop host rewrites the config before it starts a migrated agent.
    if !matches!(config.version, 1 | 2 | 3 | 4)
        || !matches!(config.provider.as_str(), "linux-agent" | "windows-agent")
        || !matches!(config.platform.as_str(), "linux" | "windows")
    {
        return Err("invalid background notification agent config".to_owned());
    }
    if config.installation_id.trim().len() < 16 || config.service_url.trim().is_empty() {
        return Err("invalid background notification agent config".to_owned());
    }
    Ok(())
}

fn parse_config_path() -> Result<String, String> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--config" {
            return args
                .next()
                .ok_or_else(|| "--config requires a path".to_owned());
        }
    }
    Err("usage: monero-fast-walletd --config <path>".to_owned())
}

fn read_config(path: &str) -> Result<AgentConfig, String> {
    let raw = fs::read_to_string(path).map_err(|_| "config could not be read".to_owned())?;
    serde_json::from_str(&raw).map_err(|_| "config is invalid".to_owned())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn run_agent(config_path: String, mut config: AgentConfig) -> Result<(), String> {
    let mut reconnect_delay_secs = 1_u64;
    loop {
        config = read_config(&config_path)?;
        validate_config(&config)?;
        if !config.enabled {
            return Ok(());
        }
        match run_stream_connection(&config_path, &config) {
            Ok(true) => return Ok(()),
            // A server-side close is still a disconnection. Wait before
            // reconnecting so a maintenance window can never turn into a
            // CPU-intensive reconnect loop.
            Ok(false) => {
                thread::sleep(Duration::from_secs(reconnect_delay_secs));
                reconnect_delay_secs = (reconnect_delay_secs * 2).min(30);
            }
            Err(error) => {
                eprintln!("monero-fast-walletd stream disconnected: {error}");
                thread::sleep(Duration::from_secs(reconnect_delay_secs));
                reconnect_delay_secs = (reconnect_delay_secs * 2).min(30);
            }
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn run_stream_connection(config_path: &str, config: &AgentConfig) -> Result<bool, String> {
    let mut request = stream_url(config)?
        .into_client_request()
        .map_err(|_| "notification stream URL is invalid".to_owned())?;
    let capability = HeaderValue::from_str(&config.installation_id)
        .map_err(|_| "notification installation capability is invalid".to_owned())?;
    request
        .headers_mut()
        .insert("x-fast-wallet-installation-id", capability);
    let (mut socket, _) =
        connect(request).map_err(|_| "notification stream could not be connected".to_owned())?;
    let mut recent_event_ids = VecDeque::with_capacity(64);
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(message) = serde_json::from_str::<StreamEventMessage>(&text) else {
                    continue;
                };
                if message.message_type != "event" || !is_opaque_event_id(&message.event.id) {
                    continue;
                }
                if recent_event_ids.iter().any(|id| id == &message.event.id) {
                    acknowledge_event(&mut socket, &message.event.id)?;
                    continue;
                }
                show_notification(config_path, config, &message.event)?;
                acknowledge_event(&mut socket, &message.event.id)?;
                recent_event_ids.push_back(message.event.id);
                if recent_event_ids.len() > 64 {
                    recent_event_ids.pop_front();
                }
            }
            Ok(Message::Ping(payload)) => {
                socket.send(Message::Pong(payload)).map_err(|_| {
                    "notification stream heartbeat could not be acknowledged".to_owned()
                })?;
                let updated = read_config(config_path)?;
                validate_config(&updated)?;
                if !updated.enabled {
                    return Ok(true);
                }
            }
            Ok(Message::Close(_)) => return Ok(false),
            Ok(_) => {}
            Err(_) => return Err("notification stream connection was interrupted".to_owned()),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn stream_url(config: &AgentConfig) -> Result<String, String> {
    let base = config.service_url.trim_end_matches('/');
    let scheme = if let Some(value) = base.strip_prefix("https://") {
        format!("wss://{value}")
    } else if let Some(value) = base.strip_prefix("http://") {
        // Local test environments may use ws. Production configuration always
        // writes https and therefore uses encrypted wss.
        format!("ws://{value}")
    } else {
        return Err("notification service must use HTTP or HTTPS".to_owned());
    };
    Ok(format!("{scheme}/stream"))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn acknowledge_event<S>(
    socket: &mut tungstenite::WebSocket<S>,
    event_id: &str,
) -> Result<(), String>
where
    S: std::io::Read + std::io::Write,
{
    let body = serde_json::to_string(&StreamAcknowledgement {
        message_type: "ack",
        event_id,
    })
    .map_err(|_| "notification acknowledgement could not be prepared".to_owned())?;
    socket
        .send(Message::Text(body.into()))
        .map_err(|_| "notification acknowledgement could not be sent".to_owned())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn show_notification(
    config_path: &str,
    config: &AgentConfig,
    event: &NotificationEvent,
) -> Result<(), String> {
    if event.category != "monero.fast_wallet.incoming"
        || !event.deep_link.starts_with("tex8://notification/")
    {
        return Ok(());
    }
    let handle = notify_rust::Notification::new()
        .summary("Monero Fast Wallet")
        .body("New private activity. Open the wallet to refresh.")
        .appname("Monero Fast Wallet")
        .action("open", "Open wallet")
        .show()
        .map_err(|_| "desktop notification could not be shown".to_owned())?;
    let event = event.clone();
    let config_path = config_path.to_owned();
    let command = config
        .app_command
        .as_ref()
        .filter(|value| Path::new(value).is_absolute() && Path::new(value).is_file())
        .cloned()
        .ok_or_else(|| "wallet app command is unavailable".to_owned())?;
    thread::spawn(move || {
        handle.wait_for_action(move |action| {
            if matches!(action, "default" | "open") {
                if let Err(error) = open_wallet_for_event(&(config_path, command), &event) {
                    eprintln!("monero-fast-walletd open failed: {error}");
                }
            }
        });
    });
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn open_wallet_for_event(
    config_and_command: &(String, String),
    event: &NotificationEvent,
) -> Result<(), String> {
    if !is_opaque_event_id(&event.id)
        || event.category != "monero.fast_wallet.incoming"
        || !event.deep_link.starts_with("tex8://notification/")
    {
        return Err("notification event is invalid".to_owned());
    }
    let config_path = Path::new(&config_and_command.0);
    let pending_path = config_path
        .parent()
        .ok_or_else(|| "notification directory is unavailable".to_owned())?
        .join("pending-open-event.json");
    let temporary = pending_path.with_extension("json.tmp");
    let pending_event = NotificationEvent {
        id: event.id.clone(),
        category: event.category.clone(),
        deep_link: event.deep_link.clone(),
        received_at: if event.received_at.trim().is_empty() {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .to_string()
        } else {
            event.received_at.clone()
        },
        opened: true,
    };
    let content = serde_json::to_vec_pretty(&pending_event)
        .map_err(|_| "pending notification event could not be stored".to_owned())?;
    fs::write(&temporary, content)
        .and_then(|_| fs::rename(&temporary, &pending_path))
        .map_err(|_| "pending notification event could not be stored".to_owned())?;
    Command::new(&config_and_command.1)
        .arg("--notification")
        .arg(&event.id)
        .spawn()
        .map_err(|_| "wallet app could not be opened".to_owned())?;
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn is_opaque_event_id(value: &str) -> bool {
    (value.len() == 68
        && value.starts_with("evt_")
        && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        || (value.len() == 39
            && value.starts_with("fwpush_")
            && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        || (value.len() == 68
            && value.starts_with("sig_")
            && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::{validate_config, AgentConfig};
    #[test]
    fn accepts_the_current_private_background_agent_contract() {
        let config = AgentConfig {
            version: 4,
            installation_id: "mwp_desktop_0123456789abcdef".to_owned(),
            platform: "windows".to_owned(),
            provider: "windows-agent".to_owned(),
            service_url: "https://xmr.tex8.com/api/v1/notifications".to_owned(),
            app_command: None,
            enabled: true,
        };
        assert!(validate_config(&config).is_ok());
    }
}
