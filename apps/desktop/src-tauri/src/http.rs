//! A deliberately small HTTP/1.1 client.
//!
//! The desktop shell needs exactly two things from the network: the OAuth token
//! exchange and authenticated calls to the server the user configured. A full
//! HTTP stack would add a large parser surface for no benefit here, so this
//! module implements the subset that is actually used and makes the security
//! relevant behaviours explicit:
//!
//! * only `http`/`https` URLs are accepted, and header values are validated so
//!   a crafted value can never inject a second request;
//! * redirects are **not** followed (a redirecting token endpoint is an
//!   exfiltration path, not a convenience);
//! * responses are bounded before they are buffered;
//! * TLS uses the platform provider through `native-tls` (SChannel, Secure
//!   Transport, or OpenSSL) — no bundled TLS implementation and no build-time C
//!   toolchain beyond what the platform already provides.

use native_tls::TlsConnector;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use url::Url;

/// Default request budget.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
/// Default response body ceiling (2 MiB).
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Room on top of the body ceiling for status line and headers.
const HEADER_SLACK: usize = 16 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("only http(s) URLs may be requested")]
    UnsupportedScheme,
    #[error("request target or header is not valid")]
    InvalidHeader,
    #[error("could not connect: {0}")]
    Connect(String),
    #[error("TLS handshake failed: {0}")]
    Tls(String),
    #[error("network I/O failed: {0}")]
    Io(String),
    #[error("response exceeded the configured size limit")]
    TooLarge,
    #[error("response could not be parsed")]
    Malformed,
    #[error("redirects are not followed")]
    Redirect(u16),
}

/// One outbound request.
pub struct Request<'a> {
    pub method: &'a str,
    pub url: &'a Url,
    pub headers: &'a [(String, String)],
    pub body: Option<&'a str>,
    pub limit: usize,
    pub timeout: Duration,
}

impl<'a> Request<'a> {
    /// A GET with a bounded body and the default timeout. Production callers go
    /// through `exchange::Transport`; this exists for the socket tests below.
    #[cfg(test)]
    pub fn get(url: &'a Url) -> Self {
        Self {
            method: "GET",
            url,
            headers: &[],
            body: None,
            limit: MAX_BODY_BYTES,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

/// A parsed response. Headers other than `Content-Type` are intentionally
/// dropped: nothing in the desktop needs them, and not keeping them means they
/// cannot be logged or returned by accident.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

/// Values may hold any visible ASCII plus spaces and tabs, but never CR, LF, or
/// NUL — those are the characters that turn a header into a request split.
fn valid_header_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains(['\r', '\n', '\0'])
        && value
            .chars()
            .all(|c| c == '\t' || (' '..='\u{7e}').contains(&c))
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_method(method: &str) -> bool {
    !method.is_empty() && method.len() <= 8 && method.chars().all(|c| c.is_ascii_uppercase())
}

/// The origin-form request target, taken from the parsed URL so it can never be
/// attacker-controlled text.
fn request_target(url: &Url) -> Result<String, HttpError> {
    let query = url.query().unwrap_or("");
    let path = if url.path().is_empty() {
        "/"
    } else {
        url.path()
    };
    let target = if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{query}")
    };
    if target.contains(['\r', '\n', ' ']) {
        return Err(HttpError::InvalidHeader);
    }
    Ok(target)
}

fn host_header(url: &Url, port: u16) -> Result<String, HttpError> {
    let host = url.host_str().ok_or(HttpError::UnsupportedScheme)?;
    let default = if url.scheme() == "https" { 443 } else { 80 };
    Ok(if port == default {
        host.to_string()
    } else {
        format!("{host}:{port}")
    })
}

enum Stream {
    Plain(TcpStream),
    Tls(Box<native_tls::TlsStream<TcpStream>>),
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(stream) => stream.read(buf),
            Stream::Tls(stream) => stream.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(stream) => stream.write(buf),
            Stream::Tls(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Stream::Plain(stream) => stream.flush(),
            Stream::Tls(stream) => stream.flush(),
        }
    }
}

/// Send one request and return the bounded response. Status codes are returned
/// to the caller rather than turned into errors, except redirects, which are
/// refused outright.
pub fn send(request: Request<'_>) -> Result<Response, HttpError> {
    let scheme = request.url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(HttpError::UnsupportedScheme);
    }
    let method = request.method.to_ascii_uppercase();
    if !valid_method(&method) {
        return Err(HttpError::InvalidHeader);
    }
    let host = request
        .url
        .host_str()
        .ok_or(HttpError::UnsupportedScheme)?
        .to_string();
    let port = request
        .url
        .port_or_known_default()
        .ok_or(HttpError::UnsupportedScheme)?;

    let mut head = format!(
        "{method} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: TraceHealer-Desktop/0.1\r\nAccept: application/json\r\nConnection: close\r\n",
        request_target(request.url)?,
        host_header(request.url, port)?
    );
    for (name, value) in request.headers {
        if !valid_header_name(name) || !valid_header_value(value) {
            return Err(HttpError::InvalidHeader);
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    let body = request.body.unwrap_or("");
    if !body.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");

    let address = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| HttpError::Connect(error.to_string()))?
        .next()
        .ok_or(HttpError::UnsupportedScheme)?;
    let tcp = TcpStream::connect_timeout(&address, request.timeout)
        .map_err(|error| HttpError::Connect(error.to_string()))?;
    tcp.set_read_timeout(Some(request.timeout))
        .map_err(|error| HttpError::Io(error.to_string()))?;
    tcp.set_write_timeout(Some(request.timeout))
        .map_err(|error| HttpError::Io(error.to_string()))?;

    let mut stream = if scheme == "https" {
        let connector = TlsConnector::new().map_err(|error| HttpError::Tls(error.to_string()))?;
        Stream::Tls(Box::new(
            connector
                .connect(&host, tcp)
                .map_err(|error| HttpError::Tls(error.to_string()))?,
        ))
    } else {
        Stream::Plain(tcp)
    };

    stream
        .write_all(head.as_bytes())
        .map_err(|error| HttpError::Io(error.to_string()))?;
    if !body.is_empty() {
        stream
            .write_all(body.as_bytes())
            .map_err(|error| HttpError::Io(error.to_string()))?;
    }
    stream
        .flush()
        .map_err(|error| HttpError::Io(error.to_string()))?;

    let ceiling = request.limit.saturating_add(HEADER_SLACK);
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                raw.extend_from_slice(&chunk[..read]);
                if raw.len() > ceiling {
                    return Err(HttpError::TooLarge);
                }
                // Stop as soon as the message is whole: a server that keeps the
                // connection open (or a proxy that never closes it) must not be
                // able to make this call wait for an EOF that will not arrive.
                if response_is_complete(&raw, request.limit) {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(HttpError::Io(error.to_string())),
        }
    }

    parse_response(&raw, request.limit)
}

/// True once `raw` holds a complete response: a head plus exactly as much body
/// as the head promised.
fn response_is_complete(raw: &[u8], limit: usize) -> bool {
    let Some(separator) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let Ok(head) = std::str::from_utf8(&raw[..separator]) else {
        return false;
    };
    let mut content_length = None;
    let mut chunked = false;
    for line in head.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.to_ascii_lowercase().contains("chunked");
        }
    }
    let body = &raw[separator + 4..];
    if chunked {
        dechunk(body, limit).is_ok()
    } else if let Some(length) = content_length {
        body.len() >= length
    } else {
        // No framing information: the body runs to the end of the connection.
        false
    }
}

/// Split and interpret a raw response buffer.
pub fn parse_response(raw: &[u8], limit: usize) -> Result<Response, HttpError> {
    let separator = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or(HttpError::Malformed)?;
    let head = std::str::from_utf8(&raw[..separator]).map_err(|_| HttpError::Malformed)?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or(HttpError::Malformed)?;
    let status = parse_status_line(status_line)?;

    let mut content_type = String::new();
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(HttpError::Malformed)?;
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-type") {
            content_type = value.to_string();
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.to_ascii_lowercase().contains("chunked");
        }
    }

    let body_raw = &raw[separator + 4..];
    let body_bytes = if chunked {
        dechunk(body_raw, limit)?
    } else if let Some(length) = content_length {
        if body_raw.len() < length {
            return Err(HttpError::Malformed);
        }
        body_raw[..length].to_vec()
    } else {
        body_raw.to_vec()
    };
    if body_bytes.len() > limit {
        return Err(HttpError::TooLarge);
    }
    if (300..400).contains(&status) {
        return Err(HttpError::Redirect(status));
    }

    Ok(Response {
        status,
        content_type,
        body: String::from_utf8_lossy(&body_bytes).to_string(),
    })
}

fn parse_status_line(line: &str) -> Result<u16, HttpError> {
    let mut parts = line.split(' ');
    let version = parts.next().ok_or(HttpError::Malformed)?;
    if !version.starts_with("HTTP/") {
        return Err(HttpError::Malformed);
    }
    let status = parts
        .next()
        .ok_or(HttpError::Malformed)?
        .parse::<u16>()
        .map_err(|_| HttpError::Malformed)?;
    if !(100..600).contains(&status) {
        return Err(HttpError::Malformed);
    }
    Ok(status)
}

/// Decode a chunked body, refusing anything beyond `limit`.
pub fn dechunk(body: &[u8], limit: usize) -> Result<Vec<u8>, HttpError> {
    let mut out = Vec::new();
    let mut cursor = 0;
    loop {
        let line_end = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or(HttpError::Malformed)?;
        let size_line = std::str::from_utf8(&body[cursor..cursor + line_end])
            .map_err(|_| HttpError::Malformed)?;
        let size_text = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| HttpError::Malformed)?;
        cursor += line_end + 2;
        if size == 0 {
            // Trailer section: read until the terminating empty line.
            let trailer_end = body[cursor..]
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap_or(0);
            cursor += trailer_end;
            let _ = cursor;
            return Ok(out);
        }
        if cursor + size + 2 > body.len() {
            return Err(HttpError::Malformed);
        }
        out.extend_from_slice(&body[cursor..cursor + size]);
        if out.len() > limit {
            return Err(HttpError::TooLarge);
        }
        cursor += size + 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test url")
    }

    /// Read one whole request: head plus whatever `Content-Length` promised.
    /// A single `read` can stop mid-message, so the harness must loop.
    fn read_request(socket: &mut TcpStream) -> String {
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match socket.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    raw.extend_from_slice(&chunk[..read]);
                    if let Some(separator) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&raw[..separator]).to_string();
                        let declared = head
                            .split("\r\n")
                            .filter_map(|line| line.split_once(':'))
                            .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if raw.len() >= separator + 4 + declared {
                            break;
                        }
                    } else if raw.len() > 64 * 1024 {
                        break;
                    }
                }
                Err(error) => panic!("test server read failed: {error}"),
            }
        }
        String::from_utf8_lossy(&raw).to_string()
    }

    /// Serve exactly one canned response on a loopback port.
    fn serve_once(response: &'static [u8]) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let request = read_request(&mut socket);
            socket.write_all(response).expect("write response");
            socket.flush().ok();
            // Drain until the client closes, so tearing the socket down here
            // cannot reset a request the client is still writing.
            let mut sink = [0u8; 1024];
            while let Ok(read) = socket.read(&mut sink) {
                if read == 0 {
                    break;
                }
            }
            request
        });
        (port, handle)
    }

    #[test]
    fn reads_a_content_length_response_from_a_real_socket() {
        let (port, handle) = serve_once(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
        );
        let response = send(Request::get(&url(&format!(
            "http://127.0.0.1:{port}/api/ready"
        ))))
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/json");
        assert_eq!(response.body, "{\"ok\":true}");

        let request = handle.join().expect("server thread");
        assert!(request.starts_with("GET /api/ready HTTP/1.1"), "{request}");
        assert!(request.contains("Host: 127.0.0.1:"), "{request}");
        assert!(request.contains("Connection: close"), "{request}");
    }

    #[test]
    fn reads_a_chunked_response() {
        let (port, handle) = serve_once(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
        );
        let response = send(Request::get(&url(&format!("http://127.0.0.1:{port}/x")))).unwrap();
        assert_eq!(response.body, "hello world");
        handle.join().ok();
    }

    #[test]
    fn posts_a_form_body() {
        let (port, handle) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        let headers = vec![(
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        )];
        let response = send(Request {
            method: "POST",
            url: &url(&format!("http://127.0.0.1:{port}/auth/token")),
            headers: &headers,
            body: Some("grant_type=authorization_code&code=abc"),
            limit: MAX_BODY_BYTES,
            timeout: DEFAULT_TIMEOUT,
        })
        .unwrap();
        assert_eq!(response.status, 200);
        let request = handle.join().expect("server thread");
        assert!(
            request.starts_with("POST /auth/token HTTP/1.1"),
            "{request}"
        );
        assert!(request.contains("Content-Length: 38"), "{request}");
        assert!(
            request.contains("grant_type=authorization_code"),
            "{request}"
        );
    }

    #[test]
    fn refuses_redirects_request_splitting_and_other_schemes() {
        let (port, handle) = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: https://evil.example/\r\nContent-Length: 0\r\n\r\n",
        );
        let error = send(Request::get(&url(&format!(
            "http://127.0.0.1:{port}/steal"
        ))))
        .unwrap_err();
        assert!(matches!(error, HttpError::Redirect(302)), "{error:?}");
        handle.join().ok();

        // A CRLF in a header value must fail before any socket work happens.
        let hostile = vec![("X-Test".to_string(), "value\r\nX-Injected: 1".to_string())];
        let error = send(Request {
            method: "GET",
            url: &url("http://127.0.0.1:9/x"),
            headers: &hostile,
            body: None,
            limit: 1024,
            timeout: Duration::from_millis(50),
        })
        .unwrap_err();
        assert!(matches!(error, HttpError::InvalidHeader), "{error:?}");

        for scheme in ["file:///etc/passwd", "ftp://host/x", "javascript:alert(1)"] {
            let error = send(Request::get(&url(scheme))).unwrap_err();
            assert!(
                matches!(error, HttpError::UnsupportedScheme),
                "{scheme}: {error:?}"
            );
        }
    }

    #[test]
    fn bounds_and_rejects_malformed_responses() {
        let too_big = {
            let body = "x".repeat(64);
            let raw = format!("HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n{body}");
            parse_response(raw.as_bytes(), 8).unwrap_err()
        };
        assert!(matches!(too_big, HttpError::TooLarge), "{too_big:?}");

        let truncated = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\nshort", 1024)
            .unwrap_err();
        assert!(matches!(truncated, HttpError::Malformed), "{truncated:?}");

        let no_headers = parse_response(b"HTTP/1.1 200 OK", 1024).unwrap_err();
        assert!(matches!(no_headers, HttpError::Malformed), "{no_headers:?}");

        let bad_version = parse_response(b"NOT-HTTP 200 OK\r\n\r\n", 1024).unwrap_err();
        assert!(
            matches!(bad_version, HttpError::Malformed),
            "{bad_version:?}"
        );

        // Chunked length beyond the ceiling is refused rather than buffered.
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n";
        let error = parse_response(chunked, 4).unwrap_err();
        assert!(matches!(error, HttpError::TooLarge), "{error:?}");
    }

    #[test]
    fn connection_failure_is_reported_as_connect_not_panic() {
        // Port 9 (discard) is not listening on loopback in the test image.
        let error = send(Request {
            method: "GET",
            url: &url("http://127.0.0.1:9/nothing"),
            headers: &[],
            body: None,
            limit: 128,
            timeout: Duration::from_millis(250),
        })
        .unwrap_err();
        assert!(
            matches!(error, HttpError::Connect(_) | HttpError::Io(_)),
            "{error:?}"
        );
    }

    #[test]
    fn request_target_preserves_query_and_rejects_whitespace() {
        assert_eq!(
            request_target(&url("http://h/api/runs?limit=2")).unwrap(),
            "/api/runs?limit=2"
        );
        assert_eq!(request_target(&url("http://h")).unwrap(), "/");
        assert_eq!(host_header(&url("http://h/x"), 80).unwrap(), "h");
        assert_eq!(host_header(&url("https://h/x"), 8443).unwrap(), "h:8443");
    }

    #[test]
    fn header_validation_rules() {
        assert!(valid_header_name("Content-Type"));
        assert!(!valid_header_name("Content Type"));
        assert!(!valid_header_name(""));
        assert!(valid_header_value("application/json; charset=utf-8"));
        assert!(!valid_header_value("a\r\nb"));
        assert!(!valid_header_value("a\nb"));
        assert!(!valid_header_value(""));
    }
}
