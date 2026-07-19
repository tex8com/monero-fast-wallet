use serde::Deserialize;
use std::{env, fs};
#[cfg(target_os = "linux")]
use std::{
    path::Path,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct AgentConfig {
    version: u8,
    installation_id: String,
    provider: String,
    service_url: String,
    poll_interval_ms: u64,
    app_command: Option<String>,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct NotificationEvent {
    id: String,
    category: String,
    deep_link: String,
    #[serde(default)]
    received_at: String,
    #[serde(default)]
    opened: bool,
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
    #[cfg(not(target_os = "linux"))]
    {
        let _ = config;
        return Err("monero-fast-walletd is supported only on Linux".to_owned());
    }
    #[cfg(target_os = "linux")]
    {
        run_linux_agent(config)
    }
}

fn validate_config(config: &AgentConfig) -> Result<(), String> {
    // Version 2 added the shared desktop notification contract fields.  Keep
    // accepting version 1 so an already installed agent can be upgraded
    // without interrupting its background notification service.
    if !matches!(config.version, 1 | 2) || config.provider != "linux-agent" {
        return Err("invalid Linux notification agent config".to_owned());
    }
    if config.installation_id.trim().len() < 16
        || config.service_url.trim().is_empty()
        || config.poll_interval_ms == 0
    {
        return Err("invalid Linux notification agent config".to_owned());
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

#[cfg(target_os = "linux")]
fn run_linux_agent(config: AgentConfig) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Monero-Fast-Wallet-Linux-Agent/0.1")
        .build()
        .map_err(|_| "notification client could not be initialized".to_owned())?;
    let mut last_event_id = String::new();
    loop {
        match fetch_events(&client, &config) {
            Ok(events) => {
                for event in events {
                    if event.id == last_event_id || !is_opaque_event_id(&event.id) {
                        continue;
                    }
                    show_linux_notification(&config, &event)?;
                    last_event_id = event.id;
                }
            }
            Err(error) => eprintln!("monero-fast-walletd poll failed: {error}"),
        }
        thread::sleep(Duration::from_millis(config.poll_interval_ms.max(10_000)));
    }
}

#[cfg(target_os = "linux")]
fn fetch_events(
    client: &reqwest::blocking::Client,
    config: &AgentConfig,
) -> Result<Vec<NotificationEvent>, String> {
    // Keep the anonymous installation capability out of URLs. URLs can be
    // retained by access logs, while this HTTPS header is deliberately not
    // logged by the gateway's Nginx configuration.
    let url = format!("{}/events", config.service_url.trim_end_matches('/'));
    let response = client
        .get(url)
        .header("x-fast-wallet-installation-id", &config.installation_id)
        .send()
        .map_err(|_| "notification service could not be reached".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "notification service returned HTTP {}",
            response.status().as_u16()
        ));
    }
    response
        .json::<Vec<NotificationEvent>>()
        .map_err(|_| "notification service returned invalid events".to_owned())
}

#[cfg(target_os = "linux")]
fn show_linux_notification(config: &AgentConfig, event: &NotificationEvent) -> Result<(), String> {
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
        .map_err(|_| "Linux desktop notification could not be shown".to_owned())?;
    let event = event.clone();
    let config_path = config_path_for_pending_event(config)?;
    thread::spawn(move || {
        handle.wait_for_action(move |action| {
            if matches!(action, "default" | "open") {
                if let Err(error) = open_wallet_for_event(&config_path, &event) {
                    eprintln!("monero-fast-walletd open failed: {error}");
                }
            }
        });
    });
    Ok(())
}

#[cfg(target_os = "linux")]
fn config_path_for_pending_event(config: &AgentConfig) -> Result<(String, String), String> {
    let config_path = env::args()
        .skip_while(|arg| arg != "--config")
        .nth(1)
        .ok_or_else(|| "agent config path is unavailable".to_owned())?;
    let command = config
        .app_command
        .as_ref()
        .filter(|value| Path::new(value).is_absolute() && Path::new(value).is_file())
        .cloned()
        .ok_or_else(|| "Linux app command is unavailable".to_owned())?;
    Ok((config_path, command))
}

#[cfg(target_os = "linux")]
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
    // The desktop host consumes the same normalized event shape on every
    // platform. The service may omit local delivery metadata, so create it
    // here without ever adding wallet data to the on-disk hand-off.
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

#[cfg(target_os = "linux")]
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
    #[cfg(target_os = "linux")]
    use super::{is_opaque_event_id, open_wallet_for_event, NotificationEvent};
    #[cfg(target_os = "linux")]
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn accepts_the_current_shared_notification_contract() {
        let config = AgentConfig {
            version: 2,
            installation_id: "mwp_linux_0123456789abcdef".to_owned(),
            provider: "linux-agent".to_owned(),
            service_url: "https://xmr.tex8.com/api/v1/notifications".to_owned(),
            poll_interval_ms: 45_000,
            app_command: None,
        };
        assert!(validate_config(&config).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn accepts_only_the_documented_opaque_event_ids() {
        assert!(is_opaque_event_id(&format!("evt_{}", "a".repeat(64))));
        assert!(is_opaque_event_id(&format!("fwpush_{}", "b".repeat(32))));
        assert!(!is_opaque_event_id("evt_wallet-address-or-amount"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn click_open_stores_only_the_validated_event_before_launching() {
        let directory = std::env::temp_dir().join(format!(
            "monero-fast-wallet-agent-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("create test notification directory");
        let event_id = format!("evt_{}", "c".repeat(64));
        let event = NotificationEvent {
            id: event_id.clone(),
            category: "monero.fast_wallet.incoming".to_owned(),
            deep_link: format!("tex8://notification/{event_id}"),
            received_at: String::new(),
            opened: false,
        };
        open_wallet_for_event(
            &(
                directory
                    .join("linux-agent.json")
                    .to_string_lossy()
                    .into_owned(),
                "/bin/true".to_owned(),
            ),
            &event,
        )
        .expect("valid opaque event opens safely");
        let pending = fs::read_to_string(directory.join("pending-open-event.json"))
            .expect("pending event file");
        assert!(pending.contains(&event_id));
        assert!(pending.contains("\"opened\": true"));
        assert!(!pending.contains("amount"));
        let _ = fs::remove_dir_all(directory);
    }
}
