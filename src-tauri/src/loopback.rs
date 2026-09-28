//! Single-use browser loopback callback for desktop sign-in.
//!
//! Design: bind 127.0.0.1 on an ephemeral port, build a PKCE-style challenge,
//! open the system browser to the identity service, then accept exactly one
//! GET /callback request carrying `code` and `state`. No credentials cross the
//! webview boundary; the verifier never leaves this process.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    str,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

use crate::account::IDENTITY_ORIGIN;

const TIMEOUT: Duration = Duration::from_secs(180);
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 8192;
const EPHEMERAL_PORT_MIN: u16 = 49152;

type Result<T> = std::result::Result<T, String>;

pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random() -> Result<Zeroizing<String>> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "Could not generate a secure sign-in.".to_string())?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes)))
}

pub struct Flow {
    listener: TcpListener,
    cancelled: Arc<AtomicBool>,
    pub port: u16,
    pub verifier: Zeroizing<String>,
    state: Zeroizing<String>,
}

pub struct CloseHandle {
    cancelled: Arc<AtomicBool>,
}

impl CloseHandle {
    pub fn close(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

impl Flow {
    pub fn bind() -> Result<Self> {
        // Retry until the OS hands back a port in the ephemeral range. Some
        // systems allocate below 49152; keep trying rather than expose a bad port.
        for _ in 0..64 {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .map_err(|_| "Could not listen for browser sign-in. Please retry.".to_string())?;
            let port = listener
                .local_addr()
                .map_err(|_| "Could not read the sign-in port.".to_string())?
                .port();
            if port < EPHEMERAL_PORT_MIN {
                continue;
            }
            return Ok(Self {
                listener,
                cancelled: Arc::new(AtomicBool::new(false)),
                port,
                verifier: random()?,
                state: random()?,
            });
        }
        Err("No ephemeral sign-in port is available. Please retry.".into())
    }

    pub fn close_handle(&self) -> CloseHandle {
        CloseHandle {
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    pub fn browser_uri(&self) -> String {
        // Confirmed against zegadb/id app/auth/desktop/route.ts: `port`,
        // `state` and `challenge` are the only parameters it accepts, and
        // both random values are base64url, so no further encoding is needed.
        format!(
            "{IDENTITY_ORIGIN}/auth/desktop?port={}&state={}&challenge={}",
            self.port,
            self.state.as_str(),
            challenge(&self.verifier)
        )
    }

    /// Accept one callback. Long-running; intended to run inside
    /// `spawn_blocking` so the Tauri command returns immediately.
    pub fn callback(self) -> Result<(Zeroizing<String>, Zeroizing<String>, Completion)> {
        let Self {
            listener,
            cancelled,
            port,
            verifier,
            state,
        } = self;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Could not configure the sign-in listener.".to_string())?;

        let deadline = Instant::now() + TIMEOUT;
        let (mut stream, peer) = loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("Sign-in cancelled.".into());
            }
            if Instant::now() >= deadline {
                return Err("Sign-in timed out waiting for your browser. Please try again.".into());
            }
            match listener.accept() {
                Ok(pair) => break pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(_) => return Err("Could not receive browser sign-in. Please retry.".into()),
            }
        };

        stream
            .set_read_timeout(Some(READ_TIMEOUT))
            .map_err(|_| "Could not configure the sign-in socket.".to_string())?;

        let mut bytes = Zeroizing::new(Vec::new());
        let mut chunk = [0u8; 256];
        loop {
            if bytes.len() >= MAX_REQUEST_BYTES {
                return Err("Invalid browser callback. Please retry.".into());
            }
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    bytes.extend_from_slice(&chunk[..n]);
                    if bytes.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    return Err("Browser callback timed out. Please retry.".into())
                }
                Err(_) => return Err("Could not read browser callback. Please retry.".into()),
            }
        }

        let code = validate(&bytes, peer, port, &state)?;
        Ok((code, verifier, Completion(stream)))
    }
}

/// A valid callback is not yet a successful exchange. The caller writes a
/// success response only once the token has been stored in the OS vault.
pub struct Completion(TcpStream);

impl Completion {
    pub fn respond(self, success: bool) {
        let _ = self.write(success);
    }

    fn write(mut self, success: bool) -> std::io::Result<()> {
        let (status, heading, guidance) = if success {
            (
                "200 OK",
                "You're signed in to zega.",
                "You can close this tab and return to the app.",
            )
        } else {
            (
                "400 Bad Request",
                "Sign-in could not be completed.",
                "Return to the app and start sign-in again. You can close this tab.",
            )
        };
        let location = if success {
            format!("Location: {IDENTITY_ORIGIN}/auth/desktop/done\r\n")
        } else {
            format!("Location: {IDENTITY_ORIGIN}/auth/desktop/failed\r\n")
        };
        let body = format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>zega sign-in</title><style>body{{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;background:#070B10;color:#F5F7F6}}main{{max-width:28rem;padding:2rem}}</style></head><body><main><h1>{heading}</h1><p>{guidance}</p></main></body></html>"
        );
        let response = format!(
            "HTTP/1.1 {status}\r\n{location}Content-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        self.0
            .set_write_timeout(Some(Duration::from_secs(1)))
            .ok();
        self.0.write_all(response.as_bytes())
    }
}

fn validate(bytes: &[u8], peer: SocketAddr, port: u16, state: &str) -> Result<Zeroizing<String>> {
    let invalid = || "Invalid browser callback. Please start sign-in again.".to_string();
    if peer.ip() != std::net::Ipv4Addr::LOCALHOST {
        return Err(invalid());
    }
    let text = str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut lines = text.split("\r\n");
    let line = lines.next().ok_or_else(invalid)?;
    let parts: Vec<_> = line.split(' ').collect();
    if parts.len() != 3
        || parts[0] != "GET"
        || parts[2] != "HTTP/1.1"
        || !parts[1].starts_with("/callback?")
        || parts[1].contains('#')
    {
        return Err(invalid());
    }

    let mut hosts = Vec::new();
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
        if name.eq_ignore_ascii_case("host") {
            hosts.push(value.trim());
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value.trim() != "0")
        {
            return Err(invalid());
        }
    }
    if hosts != [format!("127.0.0.1:{port}")] {
        return Err(invalid());
    }

    let url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{}", parts[1])).map_err(|_| invalid())?;
    if url.path() != "/callback" {
        return Err(invalid());
    }
    let query: Vec<_> = url.query_pairs().collect();
    if query.len() != 2 {
        return Err(invalid());
    }
    let states: Vec<_> = query.iter().filter(|(key, _)| key == "state").collect();
    let codes: Vec<_> = query.iter().filter(|(key, _)| key == "code").collect();
    if states.len() != 1 || codes.len() != 1 || states[0].1 != state {
        return Err("Browser sign-in did not match this attempt. Please start again.".into());
    }
    let code = &codes[0].1;
    // zega id (lib/auth-code.ts issueCode) returns a 64-char hex code, same
    // as cqx id; keep that contract.
    if code.len() != 64 || !code.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(invalid());
    }
    Ok(Zeroizing::new(code.to_string()))
}
