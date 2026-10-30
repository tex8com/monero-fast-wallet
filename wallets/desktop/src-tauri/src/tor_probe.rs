//! Bounded, blocking SOCKS5 CONNECT used by desktop route diagnostics.
//!
//! This module deliberately uses only std so its transport contract can be
//! tested without bootstrapping Tor or linking the desktop application.

use std::{
    io::{self, Read, Write},
    net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

/// Open a SOCKS5 tunnel without performing any destination HTTP request.
///
/// The local TCP connection has a separate, at most eight-second budget.
/// Greeting and destination CONNECT then share one absolute deadline: a slow
/// or fragmented response cannot reset the overall handshake budget.
pub fn connect(
    proxy: SocketAddr,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<TcpStream, String> {
    validate_host(host)?;
    if port == 0 {
        return Err("The Tor destination port is invalid.".to_owned());
    }
    if timeout.is_zero() {
        return Err(timeout_error("local proxy connection"));
    }
    let local_timeout = timeout.min(Duration::from_secs(8));
    let mut stream = TcpStream::connect_timeout(&proxy, local_timeout)
        .map_err(|error| io_error("local proxy connection", error))?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| "The Tor SOCKS handshake timeout is too large.".to_owned())?;

    write_all_until(&mut stream, &[5, 1, 0], deadline, "greeting request")?;
    let mut greeting = [0_u8; 2];
    read_exact_until(&mut stream, &mut greeting, deadline, "greeting reply")?;
    if greeting[0] != 5 {
        return Err("Tor SOCKS greeting has an invalid version.".to_owned());
    }
    if greeting[1] != 0 {
        return Err("Tor SOCKS proxy rejected anonymous authentication.".to_owned());
    }

    // Preserve remote DNS: send the hostname as a SOCKS domain address.
    let mut request = Vec::with_capacity(host.len() + 7);
    request.extend_from_slice(&[5, 1, 0, 3, host.len() as u8]);
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    write_all_until(&mut stream, &request, deadline, "CONNECT request")?;

    let mut response = [0_u8; 4];
    read_exact_until(&mut stream, &mut response, deadline, "CONNECT reply")?;
    if response[0] != 5 {
        return Err("Tor SOCKS CONNECT reply has an invalid version.".to_owned());
    }
    if response[2] != 0 {
        return Err("Tor SOCKS CONNECT reply has an invalid reserved byte.".to_owned());
    }
    if response[1] != 0 {
        let reason = match response[1] {
            1 => "general failure",
            2 => "connection not allowed",
            3 => "network unreachable",
            4 => "host unreachable",
            5 => "connection refused",
            6 => "TTL expired",
            7 => "command unsupported",
            8 => "address type unsupported",
            _ => return Err("Tor SOCKS CONNECT reply has an invalid status.".to_owned()),
        };
        return Err(format!(
            "Tor could not open the selected route: {reason} (SOCKS {}).",
            response[1]
        ));
    }

    match response[3] {
        1 => {
            let mut address = [0_u8; 4];
            read_exact_until(&mut stream, &mut address, deadline, "CONNECT IPv4 address")?;
            // Every four-byte value is a valid binary IPv4 address, including
            // the unspecified address commonly used in SOCKS success replies.
            let _ = Ipv4Addr::from(address);
        }
        3 => {
            let mut length = [0_u8; 1];
            read_exact_until(&mut stream, &mut length, deadline, "CONNECT domain length")?;
            if length[0] == 0 {
                return Err("Tor SOCKS CONNECT reply has an empty domain address.".to_owned());
            }
            let mut address = vec![0_u8; usize::from(length[0])];
            read_exact_until(
                &mut stream,
                &mut address,
                deadline,
                "CONNECT domain address",
            )?;
            let address = std::str::from_utf8(&address)
                .map_err(|_| "Tor SOCKS CONNECT reply has an invalid domain address.".to_owned())?;
            validate_host(address)
                .map_err(|_| "Tor SOCKS CONNECT reply has an invalid domain address.".to_owned())?;
        }
        4 => {
            let mut address = [0_u8; 16];
            read_exact_until(&mut stream, &mut address, deadline, "CONNECT IPv6 address")?;
            let _ = Ipv6Addr::from(address);
        }
        _ => return Err("Tor SOCKS CONNECT reply has an invalid address type.".to_owned()),
    }
    let mut bound_port = [0_u8; 2];
    read_exact_until(&mut stream, &mut bound_port, deadline, "CONNECT bound port")?;

    // The caller owns the next protocol and its own timeout budget. Do not
    // accidentally carry the almost-expired handshake deadline into HTTP.
    stream
        .set_read_timeout(None)
        .map_err(|error| io_error("timeout reset", error))?;
    stream
        .set_write_timeout(None)
        .map_err(|error| io_error("timeout reset", error))?;
    Ok(stream)
}

fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty()
        || host.len() > 255
        || !host.is_ascii()
        || host
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        Err("The Tor destination host is invalid.".to_owned())
    } else {
        Ok(())
    }
}

fn remaining(deadline: Instant, phase: &str) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| timeout_error(phase))
}

fn timeout_error(phase: &str) -> String {
    format!("Tor SOCKS {phase} timed out.")
}

fn io_error(phase: &str, error: io::Error) -> String {
    match error.kind() {
        // On macOS a blocking socket read deadline expires as WouldBlock
        // (os error 35), rather than consistently returning TimedOut.
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => timeout_error(phase),
        _ => format!("Tor SOCKS {phase}: {error}"),
    }
}

fn read_exact_until(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
    phase: &str,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < buffer.len() {
        stream
            .set_read_timeout(Some(remaining(deadline, phase)?))
            .map_err(|error| io_error(phase, error))?;
        match stream.read(&mut buffer[offset..]) {
            Ok(0) => return Err(format!("Tor SOCKS {phase}: proxy closed the connection.")),
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error(phase, error)),
        }
    }
    Ok(())
}

fn write_all_until(
    stream: &mut TcpStream,
    buffer: &[u8],
    deadline: Instant,
    phase: &str,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < buffer.len() {
        stream
            .set_write_timeout(Some(remaining(deadline, phase)?))
            .map_err(|error| io_error(phase, error))?;
        match stream.write(&buffer[offset..]) {
            Ok(0) => return Err(format!("Tor SOCKS {phase}: proxy accepted no data.")),
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error(phase, error)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread};

    const HOST: &str = "example.onion";
    const PORT: u16 = 18089;
    const IPV4_REPLY: [u8; 10] = [5, 0, 0, 1, 0, 0, 0, 0, 0, 0];

    fn proxy(
        action: impl FnOnce(TcpStream) + Send + 'static,
    ) -> (SocketAddr, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            action(stream);
        });
        (address, worker)
    }

    fn receive_greeting(stream: &mut TcpStream) {
        let mut greeting = [0_u8; 3];
        stream.read_exact(&mut greeting).unwrap();
        assert_eq!(greeting, [5, 1, 0]);
    }

    fn receive_connect(stream: &mut TcpStream) {
        let mut header = [0_u8; 5];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(header, [5, 1, 0, 3, HOST.len() as u8]);
        let mut address_and_port = vec![0_u8; HOST.len() + 2];
        stream.read_exact(&mut address_and_port).unwrap();
        assert_eq!(&address_and_port[..HOST.len()], HOST.as_bytes());
        assert_eq!(&address_and_port[HOST.len()..], &PORT.to_be_bytes());
    }

    fn error_for_reply(reply: Vec<u8>) -> String {
        let (address, worker) = proxy(move |mut stream| {
            receive_greeting(&mut stream);
            stream.write_all(&[5, 0]).unwrap();
            receive_connect(&mut stream);
            stream.write_all(&reply).unwrap();
        });
        let error = connect(address, HOST, PORT, Duration::from_secs(2)).unwrap_err();
        worker.join().unwrap();
        error
    }

    #[test]
    fn fragmented_handshake_preserves_every_byte_and_returns_the_tunnel() {
        let (address, worker) = proxy(|mut stream| {
            receive_greeting(&mut stream);
            for byte in [5, 0] {
                stream.write_all(&[byte]).unwrap();
                thread::sleep(Duration::from_millis(2));
            }
            receive_connect(&mut stream);
            for byte in IPV4_REPLY {
                stream.write_all(&[byte]).unwrap();
                thread::sleep(Duration::from_millis(2));
            }
            let mut data = [0_u8; 4];
            stream.read_exact(&mut data).unwrap();
            assert_eq!(&data, b"ping");
        });
        let mut stream = connect(address, HOST, PORT, Duration::from_secs(2)).unwrap();
        assert_eq!(stream.read_timeout().unwrap(), None);
        assert_eq!(stream.write_timeout().unwrap(), None);
        stream.write_all(b"ping").unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn delayed_connect_reply_succeeds_inside_the_shared_budget() {
        let (address, worker) = proxy(|mut stream| {
            receive_greeting(&mut stream);
            stream.write_all(&[5, 0]).unwrap();
            receive_connect(&mut stream);
            thread::sleep(Duration::from_millis(80));
            stream.write_all(&IPV4_REPLY).unwrap();
        });
        let started = Instant::now();
        connect(address, HOST, PORT, Duration::from_secs(1)).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(60));
        worker.join().unwrap();
    }

    #[test]
    fn timeout_is_bounded_and_identifies_the_connect_phase() {
        let (address, worker) = proxy(|mut stream| {
            receive_greeting(&mut stream);
            stream.write_all(&[5, 0]).unwrap();
            receive_connect(&mut stream);
            thread::sleep(Duration::from_millis(180));
        });
        let started = Instant::now();
        let error = connect(address, HOST, PORT, Duration::from_millis(40)).unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(error, "Tor SOCKS CONNECT reply timed out.");
        assert!(!error.contains("os error"));
        worker.join().unwrap();
    }

    #[test]
    fn timeout_budget_is_shared_across_fragmented_reads() {
        let (address, worker) = proxy(|mut stream| {
            receive_greeting(&mut stream);
            stream.write_all(&[5, 0]).unwrap();
            receive_connect(&mut stream);
            for byte in IPV4_REPLY {
                thread::sleep(Duration::from_millis(30));
                if stream.write_all(&[byte]).is_err() {
                    break;
                }
            }
        });
        let started = Instant::now();
        let error = connect(address, HOST, PORT, Duration::from_millis(90)).unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(error.contains("CONNECT reply timed out"), "{}", error);
        worker.join().unwrap();
    }

    #[test]
    fn rejects_authentication_and_greeting_version() {
        for (reply, expected) in [
            ([5, 0xff], "anonymous authentication"),
            ([4, 0], "invalid version"),
        ] {
            let (address, worker) = proxy(move |mut stream| {
                receive_greeting(&mut stream);
                stream.write_all(&reply).unwrap();
            });
            let error = connect(address, HOST, PORT, Duration::from_secs(1)).unwrap_err();
            assert!(error.contains(expected), "{}", error);
            worker.join().unwrap();
        }
    }

    #[test]
    fn rejects_connect_failure_and_malformed_headers() {
        for (reply, expected) in [
            (vec![5, 5, 0, 1], "connection refused"),
            (vec![5, 99, 0, 1], "invalid status"),
            (vec![4, 0, 0, 1], "invalid version"),
            (vec![5, 0, 1, 1], "reserved byte"),
            (vec![5, 0, 0, 9], "invalid address type"),
            (vec![5, 0, 0, 3, 0], "empty domain"),
            (vec![5, 0, 0, 3, 1, 0, 0, 0], "invalid domain"),
            (vec![5, 0, 0, 3, 1, 0xff, 0, 0], "invalid domain"),
        ] {
            let error = error_for_reply(reply);
            assert!(error.contains(expected), "{}", error);
        }
    }

    #[test]
    fn accepts_ipv6_and_domain_bound_addresses() {
        let mut ipv6 = vec![5, 0, 0, 4];
        ipv6.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        ipv6.extend_from_slice(&0_u16.to_be_bytes());
        let mut domain = vec![5, 0, 0, 3, 5];
        domain.extend_from_slice(b"proxy");
        domain.extend_from_slice(&0_u16.to_be_bytes());
        for reply in [ipv6, domain] {
            let (address, worker) = proxy(move |mut stream| {
                receive_greeting(&mut stream);
                stream.write_all(&[5, 0]).unwrap();
                receive_connect(&mut stream);
                stream.write_all(&reply).unwrap();
            });
            connect(address, HOST, PORT, Duration::from_secs(1)).unwrap();
            worker.join().unwrap();
        }
    }

    #[test]
    fn rejects_truncated_bound_address() {
        let error = error_for_reply(vec![5, 0, 0, 1, 127]);
        assert!(
            error.contains("CONNECT IPv4 address: proxy closed"),
            "{}",
            error
        );
    }

    #[test]
    fn validates_arguments_before_opening_a_socket() {
        let address = "127.0.0.1:1".parse().unwrap();
        for host in ["", "bad\0host", "bad host", "höst"] {
            assert!(connect(address, host, PORT, Duration::from_secs(1))
                .unwrap_err()
                .contains("host is invalid"));
        }
        assert!(connect(address, HOST, 0, Duration::from_secs(1))
            .unwrap_err()
            .contains("port is invalid"));
        assert!(connect(address, HOST, PORT, Duration::ZERO)
            .unwrap_err()
            .contains("timed out"));
    }
}
