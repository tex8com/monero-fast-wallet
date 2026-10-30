//! Small HTTP/1.x response reader for the desktop daemon health check.
//! Only std is used so framing and timeout behavior can be tested standalone.

use std::{
    io::{self, Read},
    net::TcpStream,
    time::{Duration, Instant},
};

const TIMEOUT_ERROR: &str = "The Monero daemon health response timed out. The connection will be checked again automatically.";
const LIMIT_ERROR: &str = "The Monero daemon health response exceeds its size limit.";

/// Read a complete HTTP 200 response body within one absolute deadline.
/// The limit covers headers, body, chunk framing and trailers together.
/// JSON and daemon-specific fields remain the caller's responsibility.
pub fn read_response(
    stream: &mut TcpStream,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    if limit == 0 {
        return Err(LIMIT_ERROR.to_owned());
    }
    let deadline = Instant::now()
        .checked_add(timeout)
        .filter(|_| !timeout.is_zero())
        .ok_or_else(|| TIMEOUT_ERROR.to_owned())?;
    let mut reader = ResponseReader {
        stream,
        deadline,
        remaining_bytes: limit,
    };
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        header.push(reader.byte("HTTP headers")?);
    }
    let header = std::str::from_utf8(&header)
        .map_err(|_| "The Monero daemon returned invalid HTTP headers.".to_owned())?;
    let mut lines = header[..header.len() - 4].split("\r\n");
    let mut status = lines.next().unwrap_or_default().split_whitespace();
    let version = status.next().unwrap_or_default();
    let code = status.next().unwrap_or_default();
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || code.len() != 3
        || !code.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("The Monero daemon returned an invalid HTTP status.".to_owned());
    }
    if code != "200" {
        return Err(format!(
            "The Monero daemon health endpoint returned HTTP {code}."
        ));
    }
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = parse_header(line)?;
        if name.eq_ignore_ascii_case("content-length") {
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("The Monero daemon returned an invalid Content-Length.".to_owned());
            }
            let length = value
                .parse::<usize>()
                .map_err(|_| "The Monero daemon returned an invalid Content-Length.".to_owned())?;
            if content_length.is_some_and(|previous| previous != length) {
                return Err(
                    "The Monero daemon returned conflicting Content-Length headers.".to_owned(),
                );
            }
            content_length = Some(length);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if chunked || !value.eq_ignore_ascii_case("chunked") {
                return Err(
                    "The Monero daemon returned an unsupported Transfer-Encoding.".to_owned(),
                );
            }
            chunked = true;
        }
    }
    if chunked && content_length.is_some() {
        return Err("The Monero daemon returned ambiguous HTTP response framing.".to_owned());
    }
    if chunked {
        read_chunked_body(&mut reader)
    } else if let Some(length) = content_length {
        reader.exact_body(length)
    } else {
        reader.close_delimited_body()
    }
}

fn parse_header(line: &str) -> Result<(&str, &str), String> {
    let (name, value) = line
        .split_once(':')
        .ok_or_else(|| "The Monero daemon returned a malformed HTTP header.".to_owned())?;
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() && byte != b'\t')
    {
        return Err("The Monero daemon returned a malformed HTTP header.".to_owned());
    }
    Ok((name, value.trim()))
}

fn read_chunked_body(reader: &mut ResponseReader<'_>) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        let line = reader.line("chunk size")?;
        let size = line.split(|byte| *byte == b';').next().unwrap_or_default();
        if size.is_empty() || !size.iter().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("The Monero daemon returned an invalid HTTP chunk size.".to_owned());
        }
        let size = std::str::from_utf8(size).map_err(|_| "Invalid HTTP chunk size.".to_owned())?;
        let length = usize::from_str_radix(size, 16)
            .map_err(|_| "The Monero daemon returned an invalid HTTP chunk size.".to_owned())?;
        if length == 0 {
            loop {
                let trailer = reader.line("chunk trailers")?;
                if trailer.is_empty() {
                    return Ok(body);
                }
                let trailer = std::str::from_utf8(&trailer)
                    .map_err(|_| "The Monero daemon returned invalid HTTP trailers.".to_owned())?;
                let (name, _) = parse_header(trailer)?;
                if name.eq_ignore_ascii_case("content-length")
                    || name.eq_ignore_ascii_case("transfer-encoding")
                {
                    return Err(
                        "The Monero daemon returned invalid HTTP framing trailers.".to_owned()
                    );
                }
            }
        }
        body.extend_from_slice(&reader.exact_body(length)?);
        if reader.byte("chunk terminator")? != b'\r' || reader.byte("chunk terminator")? != b'\n' {
            return Err("The Monero daemon returned an invalid HTTP chunk terminator.".to_owned());
        }
    }
}

struct ResponseReader<'a> {
    stream: &'a mut TcpStream,
    deadline: Instant,
    remaining_bytes: usize,
}

impl ResponseReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        let capacity = buffer.len().min(self.remaining_bytes);
        if capacity == 0 {
            return Err(LIMIT_ERROR.to_owned());
        }
        loop {
            let remaining = self
                .deadline
                .checked_duration_since(Instant::now())
                .filter(|duration| !duration.is_zero())
                .ok_or_else(|| TIMEOUT_ERROR.to_owned())?;
            self.stream
                .set_read_timeout(Some(remaining))
                .map_err(|error| format!("Daemon health read timeout: {error}"))?;
            match self.stream.read(&mut buffer[..capacity]) {
                Ok(count) => {
                    if Instant::now() >= self.deadline {
                        return Err(TIMEOUT_ERROR.to_owned());
                    }
                    self.remaining_bytes -= count;
                    return Ok(count);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Err(TIMEOUT_ERROR.to_owned())
                }
                Err(error) => return Err(format!("Daemon health response: {error}")),
            }
        }
    }

    fn byte(&mut self, phase: &str) -> Result<u8, String> {
        let mut byte = [0_u8; 1];
        if self.read(&mut byte)? == 0 {
            return Err(format!(
                "The Monero daemon closed an incomplete {phase} response."
            ));
        }
        Ok(byte[0])
    }

    fn line(&mut self, phase: &str) -> Result<Vec<u8>, String> {
        let mut line = Vec::new();
        while !line.ends_with(b"\r\n") {
            line.push(self.byte(phase)?);
        }
        line.truncate(line.len() - 2);
        Ok(line)
    }

    fn exact_body(&mut self, length: usize) -> Result<Vec<u8>, String> {
        if length > self.remaining_bytes {
            return Err(LIMIT_ERROR.to_owned());
        }
        let mut body = vec![0_u8; length];
        let mut offset = 0;
        while offset < length {
            let count = self.read(&mut body[offset..])?;
            if count == 0 {
                return Err("The Monero daemon closed an incomplete HTTP body.".to_owned());
            }
            offset += count;
        }
        Ok(body)
    }

    fn close_delimited_body(&mut self) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        let mut buffer = [0_u8; 2048];
        loop {
            if self.remaining_bytes == 0 {
                // A single-byte EOF probe distinguishes an exactly bounded
                // close-delimited response from a larger response. It is
                // never appended to, or allocated in, the returned body.
                self.remaining_bytes = 1;
                return if self.read(&mut buffer[..1])? == 0 {
                    Ok(body)
                } else {
                    Err(LIMIT_ERROR.to_owned())
                };
            }
            let count = self.read(&mut buffer)?;
            if count == 0 {
                return Ok(body);
            }
            body.extend_from_slice(&buffer[..count]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, thread};

    fn response(
        action: impl FnOnce(TcpStream) + Send + 'static,
        limit: usize,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        response_with_read_elapsed(action, limit, timeout).0
    }

    fn response_with_read_elapsed(
        action: impl FnOnce(TcpStream) + Send + 'static,
        limit: usize,
        timeout: Duration,
    ) -> (Result<Vec<u8>, String>, Duration) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            action(stream);
        });
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(1)).unwrap();
        let read_started = Instant::now();
        let result = read_response(&mut stream, limit, timeout);
        let read_elapsed = read_started.elapsed();
        drop(stream);
        worker.join().unwrap();
        (result, read_elapsed)
    }

    fn bytes_response(bytes: &[u8], limit: usize) -> Result<Vec<u8>, String> {
        let bytes = bytes.to_vec();
        response(
            move |mut stream| {
                let _ = stream.write_all(&bytes);
            },
            limit,
            Duration::from_secs(1),
        )
    }

    #[test]
    fn fragmented_valid_content_length_returns_only_the_complete_body() {
        let body = b"{\"height\":123,\"status\":\"OK\"}";
        let bytes =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        let result = response(
            move |mut stream| {
                for byte in bytes.iter().chain(body.iter()) {
                    stream.write_all(&[*byte]).unwrap();
                    thread::sleep(Duration::from_millis(1));
                }
            },
            1024,
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(result, body);
    }

    #[test]
    fn chunked_valid_body_decodes_extensions_and_trailers() {
        let result = bytes_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5;source=test\r\npedia\r\n0\r\nX-Probe: ok\r\n\r\n", 1024).unwrap();
        assert_eq!(result, b"Wikipedia");
    }

    #[test]
    fn connection_close_frames_a_body_without_content_length() {
        assert_eq!(
            bytes_response(b"HTTP/1.0 200 OK\r\nConnection: close\r\n\r\nbody", 1024).unwrap(),
            b"body"
        );
    }

    #[test]
    fn premature_eof_never_returns_a_partial_body() {
        for bytes in [
            &b"HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n{\"height\":1}"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabc"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n"[..],
        ] {
            assert!(bytes_response(bytes, 1024).is_err());
        }
    }

    #[test]
    fn rejects_invalid_chunks_and_ambiguous_framing() {
        for bytes in [
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX0\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n0\r\n\r\n"
                [..],
            &b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab"[..],
        ] {
            assert!(bytes_response(bytes, 1024).is_err());
        }
    }

    #[test]
    fn slow_trickle_cannot_extend_the_total_deadline() {
        let (result, read_elapsed) = response_with_read_elapsed(
            |mut stream| {
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n")
                    .unwrap();
                for _ in 0..6 {
                    thread::sleep(Duration::from_millis(35));
                    if stream.write_all(b"x").is_err() {
                        break;
                    }
                }
            },
            1024,
            Duration::from_millis(90),
        );
        assert_eq!(result.unwrap_err(), TIMEOUT_ERROR);
        assert!(
            read_elapsed < Duration::from_millis(400),
            "Health reader took {read_elapsed:?}"
        );
    }

    #[test]
    fn complete_body_arriving_after_the_absolute_deadline_is_rejected() {
        let body = b"{\"height\":123,\"status\":\"OK\"}";
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(1)).unwrap();
        let deadline = Instant::now() + Duration::from_millis(30);
        let send_after = deadline + Duration::from_millis(60);
        let worker = thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            peer.set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            thread::sleep(send_after.saturating_duration_since(Instant::now()));
            let _ = peer.write_all(body);
        });
        let mut reader = ResponseReader {
            stream: &mut stream,
            deadline,
            remaining_bytes: body.len(),
        };
        let result = reader.exact_body(body.len());
        drop(stream);
        worker.join().unwrap();
        assert_eq!(result.unwrap_err(), TIMEOUT_ERROR);
    }

    #[test]
    fn non_200_status_is_rejected() {
        assert!(bytes_response(
            b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n",
            1024
        )
        .unwrap_err()
        .contains("HTTP 503"));
    }

    #[test]
    fn limit_covers_headers_body_chunk_metadata_and_trailers() {
        let exact = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody";
        assert_eq!(bytes_response(exact, exact.len()).unwrap(), b"body");
        assert!(bytes_response(exact, exact.len() - 1)
            .unwrap_err()
            .contains("size limit"));
        assert!(bytes_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 999999999999999999\r\n\r\n",
            100
        )
        .is_err());
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n\r\n";
        assert!(bytes_response(chunked, chunked.len() - 1)
            .unwrap_err()
            .contains("size limit"));
        assert!(bytes_response(
            b"HTTP/1.1 200 OK\r\nLong-Header: abcdefghijklmnop\r\n\r\n",
            20
        )
        .unwrap_err()
        .contains("size limit"));
    }

    #[test]
    fn exactly_bounded_close_delimited_body_requires_eof() {
        let exact = b"HTTP/1.0 200 OK\r\n\r\nbody";
        assert_eq!(bytes_response(exact, exact.len()).unwrap(), b"body");
        assert!(bytes_response(b"HTTP/1.0 200 OK\r\n\r\nbody!", exact.len())
            .unwrap_err()
            .contains("size limit"));
    }
}
