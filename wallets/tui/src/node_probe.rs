//! Connection checks matching desktop `diagnose_connection_routes`.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeResult {
    pub label: String,
    pub endpoint: String,
    pub connected: bool,
    pub detail: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeKind {
    Dns,
    Tcp,
    DaemonHttp,
    Grpc,
    SocksOnion,
}

pub fn run_node_diagnostics(
    daemon: &str,
    grpc: &str,
    proxy: &str,
    optimized: bool,
) -> Vec<ProbeResult> {
    let mut results = Vec::new();
    let onion = daemon.contains(".onion");
    let socks = if proxy.trim().is_empty() {
        "127.0.0.1:9050"
    } else {
        proxy.trim()
    };
    if onion {
        results.push(probe("Tor proxy", socks, ProbeKind::Tcp));
        results.push(timed("Wallet operations · Tor", daemon, || {
            probe_socks_onion(daemon, socks)
        }));
    } else {
        results.push(probe(
            "Wallet operations · daemon",
            daemon,
            ProbeKind::DaemonHttp,
        ));
    }
    if optimized && !grpc.trim().is_empty() {
        results.push(probe(
            "Blockchain sync · Clearnet gRPC",
            grpc,
            ProbeKind::Grpc,
        ));
        let rpc = grpc
            .replace(":18091", ":18089")
            .replace(":28091", ":28089")
            .replace(":38091", ":38089");
        results.push(probe(
            "TUI wallet CLI · Clearnet RPC",
            &rpc,
            ProbeKind::DaemonHttp,
        ));
    }
    for (label, host) in [
        ("TEX8 domain", "xmr.tex8.com"),
        ("Community domain", "mfw-resolver2.tex8.com"),
    ] {
        results.push(probe(label, host, ProbeKind::Dns));
    }
    results
}

pub fn probe(label: &str, endpoint: &str, kind: ProbeKind) -> ProbeResult {
    timed(label, endpoint, || match kind {
        ProbeKind::Dns => probe_dns(endpoint),
        ProbeKind::Tcp => probe_tcp(endpoint),
        ProbeKind::DaemonHttp => probe_daemon_http(endpoint),
        ProbeKind::Grpc => probe_grpc(endpoint),
        ProbeKind::SocksOnion => probe_socks_onion(endpoint, "127.0.0.1:9050"),
    })
}

fn timed(label: &str, endpoint: &str, run: impl FnOnce() -> Result<String, String>) -> ProbeResult {
    let started = Instant::now();
    let outcome = run();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(detail) => ProbeResult {
            label: label.to_owned(),
            endpoint: endpoint.to_owned(),
            connected: true,
            detail: format!("{detail} · {elapsed_ms} ms"),
            elapsed_ms,
        },
        Err(detail) => ProbeResult {
            label: label.to_owned(),
            endpoint: endpoint.to_owned(),
            connected: false,
            detail,
            elapsed_ms,
        },
    }
}

fn split_host_port(endpoint: &str, default_port: u16) -> Result<(String, u16), String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err("No endpoint configured.".into());
    }
    if let Some((host, port)) = trimmed.rsplit_once(':') {
        if host.is_empty() {
            return Err("Host is empty.".into());
        }
        let port = port
            .parse::<u16>()
            .map_err(|_| format!("Invalid port in {trimmed}"))?;
        return Ok((host.trim_matches(['[', ']']).to_owned(), port));
    }
    Ok((trimmed.to_owned(), default_port))
}

fn probe_dns(host: &str) -> Result<String, String> {
    let addrs = (host, 443)
        .to_socket_addrs()
        .map_err(|error| format!("DNS failed: {error}"))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err("DNS returned no addresses.".into());
    }
    Ok(format!(
        "DNS ok · {}",
        addrs
            .iter()
            .take(2)
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("DNS: {error}"))?;
    let mut last = None;
    for address in addrs {
        match TcpStream::connect_timeout(&address, TIMEOUT) {
            Ok(stream) => {
                stream.set_read_timeout(Some(TIMEOUT)).ok();
                stream.set_write_timeout(Some(TIMEOUT)).ok();
                return Ok(stream);
            }
            Err(error) => last = Some(error.to_string()),
        }
    }
    Err(last.unwrap_or_else(|| "No usable address.".into()))
}

fn probe_tcp(endpoint: &str) -> Result<String, String> {
    let (host, port) = split_host_port(endpoint, 9050)?;
    let _stream = connect_tcp(&host, port)?;
    Ok("TCP open".into())
}

fn probe_daemon_http(endpoint: &str) -> Result<String, String> {
    let (host, port) = split_host_port(endpoint, 18089)?;
    let mut stream = connect_tcp(&host, port)?;
    let request = format!(
        "GET /get_height HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("daemon request: {error}"))?;
    let mut buf = [0_u8; 2048];
    let n = stream
        .read(&mut buf)
        .map_err(|error| format!("daemon response: {error}"))?;
    let text = String::from_utf8_lossy(&buf[..n]);
    if text.contains("\"height\"")
        || text.starts_with("HTTP/1.1 200")
        || text.starts_with("HTTP/1.0 200")
    {
        Ok("daemon /get_height ok".into())
    } else if n == 0 {
        Err("No HTTP response from daemon.".into())
    } else {
        Err("Daemon did not return /get_height.".into())
    }
}

fn probe_grpc(endpoint: &str) -> Result<String, String> {
    let (host, port) = split_host_port(endpoint, 18091)?;
    let mut stream = connect_tcp(&host, port)?;
    const PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\0\0\0\x04\0\0\0\0\0";
    stream
        .write_all(PREFACE)
        .map_err(|error| format!("gRPC request: {error}"))?;
    let mut header = [0_u8; 9];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("gRPC response: {error}"))?;
    let length =
        (usize::from(header[0]) << 16) | (usize::from(header[1]) << 8) | usize::from(header[2]);
    let stream_id = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) & 0x7fff_ffff;
    if header[3] != 4 || stream_id != 0 || length > 65_535 {
        return Err("Port is open, but it is not a gRPC/HTTP2 service.".into());
    }
    let mut settings = vec![0_u8; length];
    stream
        .read_exact(&mut settings)
        .map_err(|error| format!("gRPC SETTINGS: {error}"))?;
    Ok("gRPC/HTTP2 ok".into())
}

fn probe_socks_onion(endpoint: &str, proxy: &str) -> Result<String, String> {
    let (host, port) = split_host_port(endpoint, 18089)?;
    let (proxy_host, proxy_port) = split_host_port(proxy, 9050)?;
    let mut stream = connect_tcp(&proxy_host, proxy_port)
        .map_err(|error| format!("Tor SOCKS {proxy} unreachable ({error})"))?;
    stream
        .write_all(&[5, 1, 0])
        .map_err(|error| error.to_string())?;
    let mut greeting = [0_u8; 2];
    stream
        .read_exact(&mut greeting)
        .map_err(|error| format!("Tor proxy not answering SOCKS ({error})"))?;
    if greeting != [5, 0] {
        return Err("Tor SOCKS rejected anonymous authentication.".into());
    }
    let host_bytes = host.as_bytes();
    if host_bytes.is_empty() || host_bytes.len() > 255 {
        return Err("Onion host is invalid.".into());
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
            "Tor could not reach {host} (SOCKS {}).",
            response[1]
        ));
    }
    Ok("onion via Tor ok".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_host_and_port() {
        assert_eq!(
            split_host_port("xmr.tex8.com:18091", 80).unwrap(),
            ("xmr.tex8.com".into(), 18091)
        );
        assert_eq!(
            split_host_port("example.onion:18089", 1).unwrap(),
            ("example.onion".into(), 18089)
        );
    }
}
