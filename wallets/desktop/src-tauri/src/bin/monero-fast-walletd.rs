#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
//! Private, unprivileged background notification agent for Windows and Linux.
//!
//! It maintains one outbound WSS connection to the Tex8 notification gateway.
//! The gateway sends opaque event ids only; no wallet address, balance, amount,
//! transaction or key material ever reaches this process.

#[cfg(any(target_os = "linux", target_os = "windows"))]
use keyring::Entry;
use serde::Deserialize;
use std::{env, fs};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::{
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tungstenite::{
    client::IntoClientRequest, client_tls_with_config, handshake::HandshakeError,
    http::HeaderValue, protocol::WebSocketConfig, Message,
};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use zeroize::Zeroize;
#[path = "../agent_runtime/mod.rs"]
mod agent_runtime;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use agent_runtime::{AgentLog, DeliveryStage, Health, InstanceGuard, Journal};
#[cfg(target_os = "windows")]
#[path = "../windows_agent_toast/mod.rs"]
mod windows_agent_toast;

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
    let (config_path, open_notification) = agent_runtime::arguments(env::args().skip(1).collect())?;
    let config = read_config(&config_path)?;
    validate_config(&config)?;
    if let Some(id) = open_notification {
        #[cfg(target_os = "windows")]
        return open_saved_notification(&config_path, &config, &id);
        #[cfg(not(target_os = "windows"))]
        {
            let _ = id;
            return Err("persistent notification activation is Windows-only".into());
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = config;
        Err("monero-fast-walletd is supported only on Windows and Linux".to_owned())
    }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    run_agent(config_path, config)
}

fn validate_config(config: &AgentConfig) -> Result<(), String> {
    // Version 5 requires a separate CSPRNG authentication credential from the
    // OS secure store. An installation identifier alone is never sufficient.
    if config.version != 5
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

fn read_config(path: &str) -> Result<AgentConfig, String> {
    if fs::metadata(path)
        .map_err(|_| "config could not be read")?
        .len()
        > 16 * 1024
    {
        return Err("config exceeds its limit".into());
    }
    let raw = fs::read_to_string(path).map_err(|_| "config could not be read".to_owned())?;
    serde_json::from_str(&raw).map_err(|_| "config is invalid".to_owned())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn run_agent(config_path: String, _initial_config: AgentConfig) -> Result<(), String> {
    let config_path = fs::canonicalize(&config_path)
        .map_err(|_| "agent config path is invalid")?
        .into_os_string()
        .into_string()
        .map_err(|_| "agent config path is invalid")?;
    let Some(_instance) = InstanceGuard::acquire(Path::new(&config_path))? else {
        return Ok(());
    };
    let directory = Path::new(&config_path)
        .parent()
        .ok_or("agent directory is invalid")?;
    let log = AgentLog::new(directory);
    log.event("started", None);
    Health::write(directory, "starting", false, None, None);
    if !configuration_enabled(&config_path, None)? {
        Health::write(directory, "disabled", false, None, None);
        return Ok(());
    }
    let mut journal = Journal::open(directory).map_err(|error| {
        log.event("journal_error", None);
        Health::write(directory, "stopped", false, None, None);
        error
    })?;
    // Independent process, independent Arti cache/state and state lock.
    let tor_directory = directory.join("agent-tor");
    fs::create_dir_all(&tor_directory).map_err(|_| "agent Tor directory unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tor_directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "agent Tor directory unavailable")?;
    }
    monero_wallet_desktop::tor_transport::start_embedded_tor(tor_directory);
    let mut reconnect_delay_secs = 1_u64;
    loop {
        let config = read_config(&config_path)?;
        validate_config(&config)?;
        if !config.enabled {
            log.event("disabled", None);
            Health::write(directory, "disabled", false, None, None);
            return Ok(());
        }
        Health::write(directory, "connecting", false, None, None);
        let mut healthy = false;
        let outcome =
            run_stream_connection(&config_path, &config, &mut journal, &log, &mut healthy);
        if healthy {
            reconnect_delay_secs = 1;
        }
        match outcome {
            Ok(true) => return Ok(()),
            // A server-side close is still a disconnection. Wait before
            // reconnecting so a maintenance window can never turn into a
            // CPU-intensive reconnect loop.
            Ok(false) => log.event("stream_closed", None),
            Err(_) => log.event("stream_error", None),
        }
        let deadline = Instant::now() + Duration::from_secs(reconnect_delay_secs);
        Health::write(directory, "backoff", false, None, None);
        let mut health_tick = Instant::now();
        while Instant::now() < deadline {
            if !configuration_enabled(&config_path, None)? {
                log.event("disabled", None);
                Health::write(directory, "disabled", false, None, None);
                return Ok(());
            }
            if health_tick.elapsed() >= Duration::from_secs(5) {
                Health::write(directory, "backoff", false, None, None);
                health_tick = Instant::now();
            }
            thread::sleep(
                Duration::from_millis(250).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
        reconnect_delay_secs = agent_runtime::retry_delay(reconnect_delay_secs, healthy);
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn configuration_enabled(path: &str, expected: Option<&AgentConfig>) -> Result<bool, String> {
    let current = read_config(path)?;
    validate_config(&current)?;
    if let Some(expected) = expected {
        if current.installation_id != expected.installation_id
            || current.service_url != expected.service_url
            || current.app_command != expected.app_command
        {
            return Err("agent configuration changed".into());
        }
    }
    Ok(current.enabled)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
struct PollingStream {
    stream: TcpStream,
    config_path: String,
    expected: AgentConfig,
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
impl PollingStream {
    fn enabled(&self) -> std::io::Result<()> {
        if configuration_enabled(&self.config_path, Some(&self.expected)).unwrap_or(false) {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "agent configuration changed",
            ))
        }
    }
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
impl Read for PollingStream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.enabled()?;
        self.stream.read(buffer).map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                std::io::Error::new(std::io::ErrorKind::WouldBlock, "agent poll")
            } else {
                error
            }
        })
    }
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
impl Write for PollingStream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.enabled()?;
        self.stream.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn run_stream_connection(
    config_path: &str,
    config: &AgentConfig,
    journal: &mut Journal,
    log: &AgentLog,
    healthy: &mut bool,
) -> Result<bool, String> {
    let mut request = stream_url(config)?
        .into_client_request()
        .map_err(|_| "notification stream URL is invalid".to_owned())?;
    let capability = HeaderValue::from_str(&config.installation_id)
        .map_err(|_| "notification installation capability is invalid".to_owned())?;
    request
        .headers_mut()
        .insert("x-fast-wallet-installation-id", capability);
    let mut auth = load_installation_auth(&config.installation_id).map_err(|error| {
        log.event("auth_unavailable", None);
        error
    })?;
    let auth_header = HeaderValue::from_str(&auth)
        .map_err(|_| "notification installation authentication is invalid".to_owned())?;
    request
        .headers_mut()
        .insert("x-fast-wallet-installation-auth", auth_header);
    auth.zeroize();
    let host = request
        .uri()
        .host()
        .ok_or_else(|| "notification stream host is invalid".to_owned())?
        .to_owned();
    let port = request.uri().port_u16().unwrap_or_else(|| {
        if request.uri().scheme_str() == Some("wss") {
            443
        } else {
            80
        }
    });
    // The only direct socket permitted here is the loopback-only E2E harness
    // in a debug build. Production notification streams are fail-closed Tor.
    let local_test = cfg!(debug_assertions)
        && env::var_os("MONERO_FAST_WALLETD_TEST_AUTH").is_some()
        && matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    let transport = if local_test {
        let stream = TcpStream::connect((host.as_str(), port))
            .map_err(|_| "local notification test stream unavailable")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .map_err(|_| "agent poll unavailable")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .map_err(|_| "agent poll unavailable")?;
        stream
    } else {
        connect_through_tor(config_path, &host, port)?
    };
    let transport = PollingStream {
        stream: transport,
        config_path: config_path.into(),
        expected: config.clone(),
    };
    let mut attempt = client_tls_with_config(
        request,
        transport,
        Some(WebSocketConfig {
            max_message_size: Some(8192),
            max_frame_size: Some(8192),
            ..Default::default()
        }),
        None,
    );
    let handshake_started = Instant::now();
    let (mut socket, _) = loop {
        match attempt {
            Ok(connected) => break connected,
            Err(HandshakeError::Interrupted(handshake))
                if handshake_started.elapsed() < Duration::from_secs(20) =>
            {
                attempt = handshake.handshake()
            }
            Err(_) => return Err("notification stream handshake failed".into()),
        }
    };
    let directory = Path::new(config_path)
        .parent()
        .ok_or("agent directory invalid")?;
    let mut last_peer = Instant::now();
    let mut last_peer_at = agent_runtime::now();
    let mut health_tick = Instant::now();
    let mut os_phase = None;
    log.event("stream_connected", None);
    Health::write(directory, "connected", true, Some(last_peer_at), os_phase);
    loop {
        if !configuration_enabled(config_path, Some(config))? {
            log.event("disabled", None);
            Health::write(directory, "disabled", false, Some(last_peer_at), os_phase);
            return Ok(true);
        }
        if health_tick.elapsed() >= Duration::from_secs(5) {
            Health::write(directory, "connected", true, Some(last_peer_at), os_phase);
            health_tick = Instant::now();
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(message) = serde_json::from_str::<StreamEventMessage>(&text) else {
                    continue;
                };
                if message.message_type != "event" || !is_opaque_event_id(&message.event.id) {
                    continue;
                }
                if !valid_supported_event(&message.event) {
                    continue;
                }
                *healthy = true;
                last_peer = Instant::now();
                last_peer_at = agent_runtime::now();
                log.event("socket_received", Some(&message.event.id));
                let record = journal.receive_event(
                    &message.event.id,
                    &message.event.category,
                    &message.event.deep_link,
                    agent_runtime::now(),
                )?;
                let mut event = message.event;
                event.received_at = record.received_at.to_string();
                forward_received_event(config_path, &event)?;
                if !configuration_enabled(config_path, Some(config))? {
                    return Ok(true);
                }
                if !record.os_accepted() {
                    if record.uncertain() {
                        journal.mark(&event.id, DeliveryStage::PresentationUnknown)?;
                        log.event("presentation_unknown", Some(&event.id));
                    }
                    validate_app_command(config).map_err(|error| {
                        log.event("app_command_unavailable", Some(&event.id));
                        error
                    })?;
                    journal.mark(&event.id, DeliveryStage::PresentationPending)?;
                    Health::write(
                        directory,
                        "connected",
                        true,
                        Some(last_peer_at),
                        Some("presentation_pending"),
                    );
                    if show_notification(config_path, config, &event, log).is_err() {
                        journal.mark(&event.id, DeliveryStage::PresentationUnknown)?;
                        log.event("os_submit_error", Some(&event.id));
                        Health::write(
                            directory,
                            "connected",
                            true,
                            Some(last_peer_at),
                            Some("presentation_unknown"),
                        );
                        return Err("notification presentation uncertain".into());
                    }
                    journal.mark(&event.id, DeliveryStage::OsAccepted)?;
                    log.event("os_accepted", Some(&event.id));
                    os_phase = Some("os_accepted");
                } else {
                    log.event("duplicate_suppressed", Some(&event.id));
                }
                if acknowledge_event(&mut socket, &event.id).is_err() {
                    log.event("ack_error", Some(&event.id));
                    return Err("notification acknowledgement failed".into());
                }
                journal.mark(&event.id, DeliveryStage::Acknowledged)?;
                log.event("ack_sent", Some(&event.id));
            }
            Ok(Message::Ping(payload)) => {
                *healthy = true;
                last_peer = Instant::now();
                last_peer_at = agent_runtime::now();
                socket.send(Message::Pong(payload)).map_err(|_| {
                    "notification stream heartbeat could not be acknowledged".to_owned()
                })?;
            }
            Ok(Message::Pong(_)) => {
                *healthy = true;
                last_peer = Instant::now();
                last_peer_at = agent_runtime::now();
            }
            Ok(Message::Close(_)) => return Ok(false),
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                if last_peer.elapsed() > Duration::from_secs(75) {
                    return Err("notification heartbeat expired".into());
                }
            }
            Err(_) => {
                if matches!(configuration_enabled(config_path, Some(config)), Ok(false)) {
                    log.event("disabled", None);
                    Health::write(directory, "disabled", false, Some(last_peer_at), os_phase);
                    return Ok(true);
                }
                return Err("notification stream connection was interrupted".to_owned());
            }
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn connect_through_tor(config_path: &str, host: &str, port: u16) -> Result<TcpStream, String> {
    if host.is_empty() || host.len() > 255 || !host.is_ascii() || port == 0 {
        return Err("notification Tor destination is invalid".to_owned());
    }
    let timeout = Duration::from_secs(1);
    let mut stream = TcpStream::connect_timeout(
        &monero_wallet_desktop::tor_transport::socks_address()
            .parse()
            .map_err(|_| "embedded Tor address is invalid".to_owned())?,
        timeout,
    )
    .map_err(|_| "embedded Tor is not ready".to_owned())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|_| "embedded Tor timeout could not be configured".to_owned())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|_| "embedded Tor timeout could not be configured".to_owned())?;
    stream
        .write_all(&[5, 1, 0])
        .map_err(|_| "embedded Tor handshake failed".to_owned())?;
    let mut greeting = [0_u8; 2];
    responsive_read_exact(&mut stream, config_path, &mut greeting)?;
    if greeting != [5, 0] {
        return Err("embedded Tor rejected the connection".to_owned());
    }
    let host_bytes = host.as_bytes();
    let mut request = Vec::with_capacity(host_bytes.len() + 7);
    request.extend_from_slice(&[5, 1, 0, 3, host_bytes.len() as u8]);
    request.extend_from_slice(host_bytes);
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .map_err(|_| "embedded Tor request failed".to_owned())?;
    let mut response = [0_u8; 4];
    responsive_read_exact(&mut stream, config_path, &mut response)?;
    if response[0] != 5 || response[1] != 0 {
        return Err("embedded Tor could not open the notification route".to_owned());
    }
    let remaining = match response[3] {
        1 => 6,
        3 => {
            let mut length = [0_u8; 1];
            responsive_read_exact(&mut stream, config_path, &mut length)?;
            usize::from(length[0]) + 2
        }
        4 => 18,
        _ => return Err("embedded Tor returned an invalid response".to_owned()),
    };
    let mut ignored = vec![0_u8; remaining];
    responsive_read_exact(&mut stream, config_path, &mut ignored)?;
    Ok(stream)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn responsive_read_exact(
    stream: &mut TcpStream,
    config_path: &str,
    mut buffer: &mut [u8],
) -> Result<(), String> {
    let started = Instant::now();
    while !buffer.is_empty() {
        if !configuration_enabled(config_path, None)? {
            return Err("agent disabled".into());
        }
        if started.elapsed() >= Duration::from_secs(20) {
            return Err("Tor handshake timed out".into());
        }
        match stream.read(buffer) {
            Ok(0) => return Err("Tor handshake closed".into()),
            Ok(count) => {
                buffer = &mut buffer[count..];
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err("Tor handshake failed".into()),
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn load_installation_auth(installation_id: &str) -> Result<String, String> {
    #[cfg(debug_assertions)]
    if let Ok(auth) = env::var("MONERO_FAST_WALLETD_TEST_AUTH") {
        if auth.len() == 64 && auth.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(auth);
        }
        return Err("test notification installation authentication is invalid".to_owned());
    }
    let account = format!("notification-installation-auth:{installation_id}");
    let entry = Entry::new("com.tex8.monerowallet.desktop", &account)
        .map_err(|_| "notification secure storage is unavailable".to_owned())?;
    let auth = entry
        .get_password()
        .map_err(|_| "notification installation authentication is unavailable".to_owned())?;
    if auth.len() != 64 || !auth.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("notification installation authentication is invalid".to_owned());
    }
    Ok(auth)
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
fn validate_app_command(config: &AgentConfig) -> Result<String, String> {
    config
        .app_command
        .as_ref()
        .filter(|value| Path::new(value).is_absolute() && Path::new(value).is_file())
        .cloned()
        .ok_or_else(|| "wallet app command is unavailable".into())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn show_notification(
    config_path: &str,
    config: &AgentConfig,
    event: &NotificationEvent,
    log: &AgentLog,
) -> Result<(), String> {
    if !valid_supported_event(event) {
        return Ok(());
    }
    if !configuration_enabled(config_path, Some(config))? {
        return Err("agent disabled".into());
    }
    let command = validate_app_command(config)?;
    let body = if event.category == "monero.fast_wallet.vanity" {
        "Your Vanity address status changed."
    } else if event.category == "monero.fast_wallet.test" {
        "Test notification. Open the wallet to refresh."
    } else {
        "New private activity. Open the wallet to refresh."
    };
    #[cfg(target_os = "windows")]
    {
        let _ = command;
        return windows_agent_toast::show(&event.id, body, log);
    }
    #[cfg(target_os = "linux")]
    {
        let handle = notify_rust::Notification::new()
            .summary("Monero Fast Wallet")
            .body(body)
            .appname("Monero Fast Wallet")
            .action("open", "Open wallet")
            .show()
            .map_err(|_| "desktop notification could not be shown".to_owned())?;
        let event = event.clone();
        let config_path = config_path.to_owned();
        let log = log.clone();
        thread::spawn(move || {
            let _ =
                handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
                    let activation = match response {
                        notify_rust::NotificationResponse::Default => {
                            agent_runtime::Activation::Body
                        }
                        notify_rust::NotificationResponse::Action(action) => {
                            agent_runtime::Activation::Action(action)
                        }
                        _ => agent_runtime::Activation::Dismissed,
                    };
                    if agent_runtime::opens_wallet(activation) {
                        log.event("open_requested", Some(&event.id));
                        if open_wallet_for_event(&(config_path, command), &event).is_err() {
                            log.event("open_error", Some(&event.id));
                        }
                    } else {
                        log.event("dismissed", Some(&event.id));
                    }
                });
        });
        Ok(())
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn open_wallet_for_event(
    config_and_command: &(String, String),
    event: &NotificationEvent,
) -> Result<(), String> {
    if !is_opaque_event_id(&event.id) || !valid_supported_event(event) {
        return Err("notification event is invalid".to_owned());
    }
    let config_path = Path::new(&config_and_command.0);
    let pending_path = config_path
        .parent()
        .ok_or_else(|| "notification directory is unavailable".to_owned())?
        .join("pending-open-event.json");
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
    agent_runtime::atomic_write(&pending_path, &content)?;
    Command::new(&config_and_command.1)
        .arg("--notification")
        .arg(&event.id)
        .spawn()
        .map_err(|_| "wallet app could not be opened".to_owned())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_saved_notification(
    config_path: &str,
    config: &AgentConfig,
    id: &str,
) -> Result<(), String> {
    // This short process never owns the daemon lock, starts Tor, refreshes
    // enrollment, or overwrites the running agent's health.
    let path = Path::new(config_path)
        .canonicalize()
        .map_err(|_| "agent_config_path_invalid")?;
    let directory = path.parent().ok_or("agent_directory_invalid")?;
    let log = AgentLog::new(directory);
    let started = Instant::now();
    let record = loop {
        let journal = Journal::open(directory)?;
        match journal.accepted_event(id) {
            Ok(record) => break record,
            Err(_)
                if journal.pending_activation(id) && started.elapsed() < Duration::from_secs(2) =>
            {
                thread::sleep(Duration::from_millis(40))
            }
            Err(error) => {
                log.event("open_rejected", Some(id));
                return Err(error);
            }
        }
    };
    let event = NotificationEvent {
        id: id.into(),
        category: record
            .category
            .ok_or("agent_notification_metadata_missing")?,
        deep_link: record
            .deep_link
            .ok_or("agent_notification_metadata_missing")?,
        received_at: record.received_at.to_string(),
        opened: true,
    };
    let command = validate_app_command(config)?;
    log.event("open_requested", Some(id));
    let result = open_wallet_for_event(&(path.to_string_lossy().into_owned(), command), &event);
    log.event(
        if result.is_ok() {
            "open_launched"
        } else {
            "open_error"
        },
        Some(id),
    );
    result
}

fn valid_supported_event(event: &NotificationEvent) -> bool {
    (event.category == "monero.fast_wallet.incoming"
        && event.deep_link.starts_with("tex8://notification/"))
        || (event.category == "monero.fast_wallet.test"
            && event.deep_link == "tex8://notification/test")
        || (event.category == "monero.fast_wallet.vanity"
            && valid_vanity_deep_link(&event.deep_link))
}

/// Forward the actual WSS receipt even while the WebView is closed. These
/// opaque metadata files never contain a wallet, transaction or credential.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn forward_received_event(config_path: &str, event: &NotificationEvent) -> Result<(), String> {
    if !is_opaque_event_id(&event.id) || !valid_supported_event(event) {
        return Err("notification receipt is invalid".to_owned());
    }
    let directory = Path::new(config_path)
        .parent()
        .ok_or_else(|| "notification directory is unavailable".to_owned())?
        .join("received-events");
    fs::create_dir_all(&directory)
        .map_err(|_| "notification receipt directory is unavailable".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "notification receipt directory is unavailable".to_owned())?;
    }
    let received = NotificationEvent {
        id: event.id.clone(),
        category: event.category.clone(),
        deep_link: event.deep_link.clone(),
        received_at: event.received_at.clone(),
        opened: false,
    };
    let path = directory.join(format!("{}.json", event.id));
    let bytes =
        serde_json::to_vec(&received).map_err(|_| "notification receipt is invalid".to_owned())?;
    if bytes.len() > 4096 {
        return Err("notification receipt exceeds its limit".to_owned());
    }
    agent_runtime::atomic_write(&path, &bytes)?;
    let mut files = fs::read_dir(&directory)
        .map_err(|_| "notification receipt directory is unavailable".to_owned())?
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let excess = files.len().saturating_sub(64);
    for entry in files.into_iter().take(excess) {
        let _ = fs::remove_file(entry.path());
    }
    if event.category == "monero.fast_wallet.test" {
        eprintln!(
            "MONERO_DESKTOP_PUSH_RECEIVED event_id={} phase=received",
            event.id
        );
    }
    Ok(())
}

fn valid_vanity_deep_link(value: &str) -> bool {
    let Some(order_id) = value.strip_prefix("mfw://vanity/order/") else {
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

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn is_opaque_event_id(value: &str) -> bool {
    agent_runtime::opaque_id(value)
}

#[cfg(test)]
mod tests {
    use super::{validate_config, AgentConfig};
    #[test]
    fn accepts_the_current_private_background_agent_contract() {
        let config = AgentConfig {
            version: 5,
            installation_id: "mwp_desktop_0123456789abcdef".to_owned(),
            platform: "windows".to_owned(),
            provider: "windows-agent".to_owned(),
            service_url: "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion/api/v1/notifications".to_owned(),
            app_command: None,
            enabled: true,
        };
        assert!(validate_config(&config).is_ok());
    }
}
