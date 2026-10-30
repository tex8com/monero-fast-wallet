use arti_client::{config::TorClientConfigBuilder, TorClient};
use reqwest::Proxy;
use serde::Serialize;
use std::{
    fs,
    net::{Ipv4Addr, Ipv6Addr, TcpListener as StdTcpListener},
    panic::{self, AssertUnwindSafe},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, RwLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
#[cfg(not(target_os = "windows"))]
use tor_rtcompat::PreferredRuntime as EmbeddedTorRuntime;
#[cfg(target_os = "windows")]
use tor_rtcompat::{tokio::TokioNativeTlsRuntime as EmbeddedTorRuntime, ToplevelBlockOn};

/// Desktop service traffic is fail-closed through the app's embedded Arti Tor
/// client. The native Monero Fast Node gRPC block provider is intentionally
/// separate and remains Clearnet.
const PREFERRED_TOR_SOCKS_ADDRESS: &str = "127.0.0.1:19050";

static TOR_STARTED: OnceLock<()> = OnceLock::new();
static TOR_STATUS: OnceLock<Mutex<TorStatus>> = OnceLock::new();
static TOR_SOCKS_ADDRESS: OnceLock<RwLock<String>> = OnceLock::new();
static TOR_WORKER_ALIVE: AtomicBool = AtomicBool::new(false);
static TOR_STATUS_CHANGED_AT_MS: AtomicU64 = AtomicU64::new(0);
static TOR_LAST_READY_AT_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
enum TorStatus {
    Starting,
    Bootstrapping,
    Ready,
    Failed(String),
}

fn status() -> &'static Mutex<TorStatus> {
    TOR_STATUS.get_or_init(|| Mutex::new(TorStatus::Starting))
}

fn set_status(next: TorStatus) {
    let ready = matches!(next, TorStatus::Ready);
    if let Ok(mut current) = status().lock() {
        *current = next;
    }
    let changed_at = now_ms();
    TOR_STATUS_CHANGED_AT_MS.store(changed_at, Ordering::Release);
    if ready {
        TOR_LAST_READY_AT_MS.store(changed_at, Ordering::Release);
    }
}

fn socks_address_state() -> &'static RwLock<String> {
    TOR_SOCKS_ADDRESS.get_or_init(|| RwLock::new(PREFERRED_TOR_SOCKS_ADDRESS.to_owned()))
}

pub fn socks_address() -> String {
    socks_address_state()
        .read()
        .map(|address| address.clone())
        .unwrap_or_else(|_| PREFERRED_TOR_SOCKS_ADDRESS.to_owned())
}

pub fn proxy_uri() -> String {
    format!("socks5h://{}", socks_address())
}

fn reserve_socks_listener(preferred: Option<&str>) -> Result<StdTcpListener, String> {
    let requested = preferred.unwrap_or(PREFERRED_TOR_SOCKS_ADDRESS);
    let listener = match StdTcpListener::bind(requested) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "MONERO_DESKTOP_TOR socks-port-unavailable address={requested} action=ephemeral-fallback error={error}"
            );
            StdTcpListener::bind("127.0.0.1:0")
                .map_err(|fallback| format!("Embedded Tor SOCKS port reservation: {fallback}"))?
        }
    };
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Embedded Tor SOCKS listener mode: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Embedded Tor SOCKS listener address: {error}"))?
        .to_string();
    if let Ok(mut current) = socks_address_state().write() {
        *current = address;
    }
    Ok(listener)
}

/// Start Tor on its own runtime and return immediately. Nothing in this path
/// may delay the Tauri window or wallet startup.
pub fn start_embedded_tor(data_dir: PathBuf) {
    // Arti's persistent directory format is not a stable cross-version
    // contract. Keep the established Windows state directory separate from
    // directories used by earlier desktop runtime configurations.
    #[cfg(target_os = "windows")]
    let data_dir = data_dir.join("arti-043");
    TOR_STARTED.get_or_init(|| {
        set_status(TorStatus::Starting);
        let reserved_listener = reserve_socks_listener(None);
        let spawn_result = std::thread::Builder::new()
            .name("mfw-embedded-tor".to_owned())
            .spawn(move || {
                TOR_WORKER_ALIVE.store(true, Ordering::Release);
                let mut reserved_listener = Some(reserved_listener);
                loop {
                    set_status(TorStatus::Starting);
                    let listener = match reserved_listener
                        .take()
                        .unwrap_or_else(|| reserve_socks_listener(Some(&socks_address())))
                    {
                        Ok(listener) => listener,
                        Err(error) => {
                            set_status(TorStatus::Failed(error.clone()));
                            eprintln!("MONERO_DESKTOP_TOR listener-failed error={error}");
                            std::thread::sleep(Duration::from_secs(2));
                            continue;
                        }
                    };
                    let attempt = panic::catch_unwind(AssertUnwindSafe(|| {
                        #[cfg(target_os = "windows")]
                        {
                            // Match the runtime used by the official Arti binary on
                            // Windows. A raw Tokio runtime stalled while fetching the
                            // first consensus on Windows ARM64.
                            let runtime = EmbeddedTorRuntime::create()
                                .map_err(|error| format!("Tor runtime: {error}"))?;
                            return runtime.block_on(run_embedded_tor(
                                data_dir.clone(),
                                runtime.clone(),
                                listener,
                            ));
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            let runtime = tokio::runtime::Builder::new_multi_thread()
                                .worker_threads(2)
                                .thread_name("mfw-tor-runtime")
                                .enable_all()
                                .build()
                                .map_err(|error| format!("Tor runtime: {error}"))?;
                            runtime.block_on(run_embedded_tor(data_dir.clone(), listener))
                        }
                    }));
                    match attempt {
                        Ok(Ok(())) => {
                            set_status(TorStatus::Failed(
                                "Embedded Tor stopped unexpectedly.".to_owned(),
                            ));
                        }
                        Ok(Err(error)) => {
                            set_status(TorStatus::Failed(error.clone()));
                            eprintln!("MONERO_DESKTOP_TOR embedded-failed error={error}");
                        }
                        Err(_) => {
                            let error =
                                "Embedded Tor worker panicked and is restarting.".to_owned();
                            set_status(TorStatus::Failed(error.clone()));
                            eprintln!("MONERO_DESKTOP_TOR worker-panicked action=restart");
                        }
                    }
                    // A failed bootstrap or unexpected worker panic must not
                    // permanently remove Tor from the running desktop app.
                    std::thread::sleep(Duration::from_secs(2));
                }
            });
        if let Err(error) = spawn_result {
            set_status(TorStatus::Failed(format!("Tor worker: {error}")));
        }
    });
}

#[cfg(not(target_os = "windows"))]
async fn run_embedded_tor(data_dir: PathBuf, listener: StdTcpListener) -> Result<(), String> {
    let runtime =
        EmbeddedTorRuntime::current().map_err(|error| format!("Tor runtime handle: {error}"))?;
    run_embedded_tor_with_runtime(data_dir, runtime, listener).await
}

#[cfg(target_os = "windows")]
async fn run_embedded_tor(
    data_dir: PathBuf,
    runtime: EmbeddedTorRuntime,
    listener: StdTcpListener,
) -> Result<(), String> {
    run_embedded_tor_with_runtime(data_dir, runtime, listener).await
}

async fn run_embedded_tor_with_runtime(
    data_dir: PathBuf,
    runtime: EmbeddedTorRuntime,
    listener: StdTcpListener,
) -> Result<(), String> {
    let state_dir = data_dir.join("state");
    let cache_dir = data_dir.join("cache");
    fs::create_dir_all(&state_dir).map_err(|error| format!("Tor state directory: {error}"))?;
    fs::create_dir_all(&cache_dir).map_err(|error| format!("Tor cache directory: {error}"))?;

    // Bind before bootstrap. Local callers can connect immediately while Arti
    // obtains directory data in the background; the app UI is never blocked.
    let listener = TcpListener::from_std(listener)
        .map_err(|error| format!("Embedded Tor SOCKS listener: {error}"))?;
    let config = TorClientConfigBuilder::from_directories(state_dir, cache_dir)
        .build()
        .map_err(|error| format!("Embedded Tor configuration: {error}"))?;
    let client = TorClient::with_runtime(runtime)
        .config(config)
        .create_unbootstrapped_async()
        .await
        .map_err(|error| format!("Embedded Tor client: {error}"))?;

    set_status(TorStatus::Bootstrapping);
    let status_client = client.clone();
    let status_logger = tokio::spawn(async move {
        let mut previous = String::new();
        loop {
            let current = status_client.bootstrap_status().to_string();
            if current != previous {
                eprintln!("MONERO_DESKTOP_TOR bootstrap-status detail={current}");
                previous = current;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let bootstrap_result = client.bootstrap().await;
    status_logger.abort();
    bootstrap_result.map_err(|error| format!("Tor bootstrap: {error}"))?;
    set_status(TorStatus::Ready);
    eprintln!("MONERO_DESKTOP_TOR embedded-ready");

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|error| format!("Embedded Tor SOCKS accept: {error}"))?;
        let client = client.clone();
        tokio::spawn(async move {
            if let Err(error) = proxy_connection(stream, client).await {
                eprintln!("MONERO_DESKTOP_TOR socks-connection-failed error={error}");
            }
        });
    }
}

async fn proxy_connection(
    mut local: TcpStream,
    client: Arc<TorClient<EmbeddedTorRuntime>>,
) -> Result<(), String> {
    let protocol = detect_socks_protocol(&local).await?;
    let (host, port) = match protocol {
        SocksProtocol::V4 => read_socks4_request(&mut local).await?,
        SocksProtocol::V5 => read_socks5_request(&mut local).await?,
    };
    let mut remote = match client.connect((host.as_str(), port)).await {
        Ok(stream) => stream,
        Err(error) => {
            let _ = write_socks_reply(&mut local, protocol, false).await;
            return Err(format!("Tor destination connection failed: {error}"));
        }
    };
    set_status(TorStatus::Ready);
    write_socks_reply(&mut local, protocol, true).await?;
    tokio::io::copy_bidirectional(&mut local, &mut remote)
        .await
        .map_err(|error| format!("Tor relay: {error}"))?;
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SocksProtocol {
    V4,
    V5,
}

async fn detect_socks_protocol(stream: &TcpStream) -> Result<SocksProtocol, String> {
    let mut version = [0_u8; 1];
    stream
        .peek(&mut version)
        .await
        .map_err(|error| format!("SOCKS protocol: {error}"))?;
    match version[0] {
        4 => Ok(SocksProtocol::V4),
        5 => Ok(SocksProtocol::V5),
        _ => Err("The local proxy received an unsupported SOCKS protocol.".to_owned()),
    }
}

// Monero Core deliberately uses SOCKS4a for daemon proxy connections. The
// 0.0.0.1 marker keeps .onion hostname resolution inside Arti instead of
// leaking it to the host resolver.
async fn read_socks4_request(stream: &mut TcpStream) -> Result<(String, u16), String> {
    let mut header = [0_u8; 8];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|error| format!("SOCKS4 header: {error}"))?;
    if header[0] != 4 || header[1] != 1 {
        let _ = write_socks_reply(stream, SocksProtocol::V4, false).await;
        return Err("Only SOCKS4 CONNECT requests are supported.".to_owned());
    }
    let port = u16::from_be_bytes([header[2], header[3]]);
    if port == 0 {
        let _ = write_socks_reply(stream, SocksProtocol::V4, false).await;
        return Err("The SOCKS destination port is invalid.".to_owned());
    }

    // The user id is unused by Monero and Arti, but it is part of SOCKS4.
    read_null_terminated(stream, 1024, "SOCKS4 user id").await?;
    let host = if header[4..7] == [0, 0, 0] && header[7] != 0 {
        let bytes = read_null_terminated(stream, 255, "SOCKS4a hostname").await?;
        let host = String::from_utf8(bytes)
            .map_err(|_| "The SOCKS destination hostname is invalid.".to_owned())?;
        validate_hostname(&host)?;
        host
    } else {
        Ipv4Addr::new(header[4], header[5], header[6], header[7]).to_string()
    };
    Ok((host, port))
}

async fn read_null_terminated(
    stream: &mut TcpStream,
    max_length: usize,
    field: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let byte = stream
            .read_u8()
            .await
            .map_err(|error| format!("{field}: {error}"))?;
        if byte == 0 {
            return Ok(bytes);
        }
        if bytes.len() >= max_length {
            return Err(format!("{field} is too long."));
        }
        bytes.push(byte);
    }
}

fn validate_hostname(host: &str) -> Result<(), String> {
    if host.is_empty() || !host.is_ascii() || host.contains('\0') {
        return Err("The SOCKS destination hostname is invalid.".to_owned());
    }
    Ok(())
}

async fn read_socks5_request(stream: &mut TcpStream) -> Result<(String, u16), String> {
    let mut greeting = [0_u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|error| format!("SOCKS greeting: {error}"))?;
    if greeting[0] != 5 || greeting[1] == 0 {
        return Err("Only SOCKS5 connections are supported.".to_owned());
    }
    let mut methods = vec![0_u8; usize::from(greeting[1])];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|error| format!("SOCKS authentication: {error}"))?;
    if !methods.contains(&0) {
        let _ = stream.write_all(&[5, 0xff]).await;
        return Err("The SOCKS client did not offer anonymous authentication.".to_owned());
    }
    stream
        .write_all(&[5, 0])
        .await
        .map_err(|error| format!("SOCKS authentication reply: {error}"))?;

    let mut request = [0_u8; 4];
    stream
        .read_exact(&mut request)
        .await
        .map_err(|error| format!("SOCKS request: {error}"))?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        let _ = write_socks5_reply(stream, 7).await;
        return Err("Only SOCKS5 CONNECT requests are supported.".to_owned());
    }

    let host = match request[3] {
        1 => {
            let mut bytes = [0_u8; 4];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|error| format!("SOCKS IPv4 address: {error}"))?;
            Ipv4Addr::from(bytes).to_string()
        }
        3 => {
            let length = stream
                .read_u8()
                .await
                .map_err(|error| format!("SOCKS hostname length: {error}"))?;
            if length == 0 {
                return Err("The SOCKS destination hostname is empty.".to_owned());
            }
            let mut bytes = vec![0_u8; usize::from(length)];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|error| format!("SOCKS hostname: {error}"))?;
            let host = String::from_utf8(bytes)
                .map_err(|_| "The SOCKS destination hostname is invalid.".to_owned())?;
            validate_hostname(&host)?;
            host
        }
        4 => {
            let mut bytes = [0_u8; 16];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|error| format!("SOCKS IPv6 address: {error}"))?;
            Ipv6Addr::from(bytes).to_string()
        }
        _ => {
            let _ = write_socks5_reply(stream, 8).await;
            return Err("The SOCKS destination address type is unsupported.".to_owned());
        }
    };
    let port = stream
        .read_u16()
        .await
        .map_err(|error| format!("SOCKS destination port: {error}"))?;
    if port == 0 {
        return Err("The SOCKS destination port is invalid.".to_owned());
    }
    Ok((host, port))
}

async fn write_socks5_reply(stream: &mut TcpStream, status: u8) -> Result<(), String> {
    stream
        .write_all(&[5, status, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|error| format!("SOCKS reply: {error}"))
}

async fn write_socks_reply(
    stream: &mut TcpStream,
    protocol: SocksProtocol,
    success: bool,
) -> Result<(), String> {
    match protocol {
        SocksProtocol::V4 => stream
            .write_all(&[0, if success { 90 } else { 91 }, 0, 0, 0, 0, 0, 0])
            .await
            .map_err(|error| format!("SOCKS4 reply: {error}")),
        SocksProtocol::V5 => write_socks5_reply(stream, if success { 0 } else { 1 }).await,
    }
}

pub fn diagnostic_status() -> String {
    match status().lock().map(|current| current.clone()) {
        Ok(TorStatus::Starting) => "Embedded Tor is starting.".to_owned(),
        Ok(TorStatus::Bootstrapping) => "Embedded Tor is connecting to the Tor network.".to_owned(),
        Ok(TorStatus::Ready) => "Embedded Tor is ready.".to_owned(),
        Ok(TorStatus::Failed(error)) => error,
        Err(_) => "Embedded Tor status is unavailable.".to_owned(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorStatusSnapshot {
    pub phase: String,
    pub connected: bool,
    pub endpoint: String,
    pub checked_at_ms: u64,
    pub last_ready_at_ms: u64,
    pub worker_alive: bool,
    pub error: Option<String>,
}

pub fn status_snapshot() -> TorStatusSnapshot {
    let (phase, connected, error) = match status().lock().map(|current| current.clone()) {
        Ok(TorStatus::Starting) => ("starting", false, None),
        Ok(TorStatus::Bootstrapping) => ("checking", false, None),
        Ok(TorStatus::Ready) => ("connected", true, None),
        Ok(TorStatus::Failed(error)) => ("error", false, Some(error)),
        Err(_) => (
            "error",
            false,
            Some("Embedded Tor status is unavailable.".to_owned()),
        ),
    };
    TorStatusSnapshot {
        phase: phase.to_owned(),
        connected,
        endpoint: socks_address(),
        checked_at_ms: TOR_STATUS_CHANGED_AT_MS.load(Ordering::Acquire),
        last_ready_at_ms: TOR_LAST_READY_AT_MS.load(Ordering::Acquire),
        worker_alive: TOR_WORKER_ALIVE.load(Ordering::Acquire),
        error,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn proxy() -> Result<Proxy, String> {
    Proxy::all(proxy_uri()).map_err(|_| "The embedded desktop Tor proxy is unavailable.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occupied_socks_port_uses_an_app_private_fallback() {
        let occupied = StdTcpListener::bind("127.0.0.1:0").expect("reserve occupied port");
        let occupied_address = occupied.local_addr().expect("occupied address").to_string();
        let fallback = reserve_socks_listener(Some(&occupied_address)).expect("fallback listener");
        assert_ne!(
            fallback.local_addr().expect("fallback address"),
            occupied.local_addr().expect("occupied address")
        );
    }

    #[test]
    fn service_proxy_uses_remote_dns_through_embedded_tor() {
        assert!(socks_address().starts_with("127.0.0.1:"));
        assert!(proxy_uri().starts_with("socks5h://127.0.0.1:"));
        assert!(proxy().is_ok());
    }

    #[test]
    fn initial_status_is_fail_closed() {
        assert_ne!(diagnostic_status(), "Embedded Tor is ready.");
    }
}
