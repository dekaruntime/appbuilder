//! Sign in with ChatGPT: answers run on the signed-in user's own ChatGPT
//! plan (developers.openai.com/siwc, token sharing for open-source apps).
//!
//! There is nothing to register: the first sign-in registers this install
//! dynamically (`dynamic_agent_client`) and OpenAI hands back the issued
//! client ID on the loopback callback. The refresh token lives only in the OS
//! keychain and the one-hour access token only in memory; the file beside
//! the app's settings holds nothing secret. Only the question the user types
//! is sent. Nothing from the computer graph leaves the machine.
//!
//! Every answer's token counts (from `response.completed`) are kept on this
//! Mac as daily totals, so people can see how zega uses their plan.

use crate::loopback;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::BufRead,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

// From https://auth.openai.com/.well-known/openid-configuration.
const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE: &str = "https://auth.openai.com/api/accounts/oauth/revoke";
const RESOURCE: &str = "https://api.openai.com/v1";
const RESPONSES: &str = "https://api.openai.com/v1/responses";
const MODELS: &str = "https://api.openai.com/v1/models";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "zega";
const CALLBACK_PATH: &str = "/auth/callback";
const KEYCHAIN_SERVICE: &str = "earth.zega.desktop";
const KEYCHAIN_USER: &str = "chatgpt-refresh-token";
const SAVED_FILE: &str = "chatgpt.json";
const USAGE_FILE: &str = "chatgpt-usage.json";
// Daily totals kept for the "last 7 days" view; older days fold into
// all-time only.
const USAGE_DAYS_KEPT: i64 = 60;
const CHANGED: &str = "chatgpt-changed";
const MAX_QUESTION: usize = 8000;
// Refresh a little early so a request never starts on a token about to lapse.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

type Result<T> = std::result::Result<T, String>;

/// What persists beside the app's settings. Nothing here is a credential.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    /// This install's `ext_agent_host_id`, chosen before its first sign-in
    /// and kept for good, across disconnects.
    host_id: String,
    /// The client ID OpenAI issued to this install for the signed-in user.
    client_id: Option<String>,
    email: Option<String>,
}

#[derive(Clone, Default, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    SignedOut,
    Pending,
    SignedIn,
}

#[derive(Clone, Default, Serialize, Debug)]
pub struct View {
    pub status: Status,
    pub email: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}

/// Tokens one answer used, as `response.completed` reports them.
#[derive(Clone, Copy, Default, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default)]
pub struct Tokens {
    pub input: u64,
    /// Part of `input` served from OpenAI's prompt cache.
    pub cached_input: u64,
    pub output: u64,
    /// Part of `output` spent on reasoning the user doesn't see.
    pub reasoning: u64,
}

impl Tokens {
    fn from_usage(usage: &Value) -> Option<Self> {
        Some(Self {
            input: usage["input_tokens"].as_u64()?,
            cached_input: usage["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0),
            output: usage["output_tokens"].as_u64()?,
            reasoning: usage["output_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0),
        })
    }
}

/// Answers and tokens over some period.
#[derive(Clone, Copy, Default, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default)]
pub struct Totals {
    pub answers: u64,
    pub input: u64,
    pub output: u64,
}

impl Totals {
    fn add(&mut self, tokens: &Tokens) {
        self.answers += 1;
        self.input += tokens.input;
        self.output += tokens.output;
    }
}

/// Totals persisted on this Mac. Days are local dates (YYYY-MM-DD).
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct UsageLog {
    days: BTreeMap<String, Totals>,
    all_time: Totals,
}

impl UsageLog {
    fn record(&mut self, day: chrono::NaiveDate, tokens: &Tokens) {
        self.days.entry(day.to_string()).or_default().add(tokens);
        self.all_time.add(tokens);
        let oldest = (day - chrono::Duration::days(USAGE_DAYS_KEPT)).to_string();
        self.days.retain(|kept, _| *kept > oldest);
    }

    fn summary(&self, today: chrono::NaiveDate) -> UsageSummary {
        let week_start = (today - chrono::Duration::days(6)).to_string();
        let today = today.to_string();
        let mut last_7_days = Totals::default();
        for (_, totals) in self.days.iter().filter(|(day, _)| **day >= week_start && **day <= today) {
            last_7_days.answers += totals.answers;
            last_7_days.input += totals.input;
            last_7_days.output += totals.output;
        }
        UsageSummary {
            today: self.days.get(&today).copied().unwrap_or_default(),
            last_7_days,
            all_time: self.all_time,
        }
    }
}

#[derive(Clone, Copy, Serialize, Debug, PartialEq)]
pub struct UsageSummary {
    pub today: Totals,
    pub last_7_days: Totals,
    pub all_time: Totals,
}

/// One step of a streamed answer, sent to the webview over a channel.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AskEvent {
    Delta { text: String },
    Completed {
        /// Absent only if OpenAI leaves usage out of the final event.
        tokens: Option<Tokens>,
        /// From sending the question to the answer's last word.
        elapsed_ms: u64,
        /// From sending the question to its first word.
        first_word_ms: Option<u64>,
    },
    Failed {
        code: Option<String>,
        message: String,
        /// The plan's limit is reached: show "Manage usage".
        usage_limited: bool,
    },
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: u64,
}

struct Access {
    token: Zeroizing<String>,
    expires: Instant,
}

#[derive(Default)]
struct Inner {
    saved: Saved,
    access: Option<Access>,
    pending: Option<loopback::CloseHandle>,
    error: Option<String>,
}

pub struct ChatGptState {
    app: tauri::AppHandle,
    client: reqwest::blocking::Client,
    /// Streams run as long as the answer does; only connecting is bounded.
    streaming: reqwest::blocking::Client,
    inner: Mutex<Inner>,
    /// One refresh at a time: refresh tokens rotate, and a second refresh
    /// with the old one would be refused as reused.
    refreshing: Mutex<()>,
}

fn keychain() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|_| "Cannot open the OS keychain. Unlock it and retry.".into())
}

fn read_refresh() -> Result<Option<Zeroizing<String>>> {
    match keychain()?.get_password() {
        Ok(token) => Ok(Some(Zeroizing::new(token))),
        Err(keyring::Error::NoEntry) => Ok(None),
        // Do not format keyring errors: BadEncoding can contain the secret.
        Err(_) => Err("Cannot read the OS keychain. Unlock it and retry.".into()),
    }
}

fn save_refresh(token: &str) -> Result<()> {
    keychain()?
        .set_password(token)
        .map_err(|_| "Cannot save the ChatGPT sign-in in the OS keychain. Unlock it and retry.".into())
}

fn clear_refresh() -> Result<()> {
    match keychain()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the ChatGPT sign-in from the OS keychain. Unlock it and retry.".into()),
    }
}

/// A random version 4 UUID as a URN, the host ID form the docs accept.
fn new_host_id() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|_| "Could not generate this install's ID.".to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "urn:uuid:{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The authorize URL. A first sign-in registers with `dynamic_agent_client`
/// and names the app; a returning one reuses the issued client ID.
fn authorize_url(
    client_id: Option<&str>,
    login_hint: Option<&str>,
    host_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
) -> Result<reqwest::Url> {
    let mut params = vec![
        ("client_id", client_id.unwrap_or(DYNAMIC_CLIENT)),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPE),
        ("resource", RESOURCE),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge),
        ("ext_agent_host_id", host_id),
    ];
    match client_id {
        None => params.push(("agent_name_hint", AGENT_NAME)),
        Some(_) => {
            if let Some(hint) = login_hint {
                params.push(("login_hint", hint));
            }
        }
    }
    reqwest::Url::parse_with_params(AUTHORIZE, &params).map_err(|_| "Could not build the ChatGPT sign-in link.".into())
}

#[derive(Debug, PartialEq)]
struct Claims {
    email: Option<String>,
}

/// Check the ID token from the token response. It arrives straight from the
/// token endpoint over TLS, so the issuer is already authenticated (OpenID
/// Connect Core 3.1.3.7); what's left is that it was minted for this client,
/// for this attempt, and is current.
fn check_id_token(token: &str, client_id: &str, nonce: &str, now: u64) -> Result<Claims> {
    let invalid = || "ChatGPT returned a sign-in this app can't verify. Please try again.".to_string();
    let payload = token.split('.').nth(1).ok_or_else(invalid)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?;
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let audience_ok = match &claims["aud"] {
        Value::String(aud) => aud == client_id,
        Value::Array(auds) => auds.iter().any(|aud| aud == client_id),
        _ => false,
    };
    if claims["iss"] != ISSUER
        || !audience_ok
        || claims["nonce"] != nonce
        || claims["exp"].as_u64().is_none_or(|exp| exp <= now)
    {
        return Err(invalid());
    }
    Ok(Claims {
        email: claims["email"].as_str().map(str::to_owned),
    })
}

/// What a failed answer tells the user, per the documented error codes.
fn failure(code: Option<&str>, message: Option<&str>) -> AskEvent {
    let (message, usage_limited) = match code {
        Some("subscription_sharing_usage_limit_exceeded") => {
            ("You've reached your ChatGPT plan's limit for now.".to_string(), true)
        }
        Some("subscription_sharing_user_not_eligible") => {
            ("Your ChatGPT plan doesn't include usage in other apps.".to_string(), false)
        }
        Some("subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable") => {
            ("ChatGPT is busy right now. Try again in a moment.".to_string(), false)
        }
        Some("subscription_sharing_invalid_user") => (
            "Your ChatGPT sign-in is no longer valid. Continue with ChatGPT to reconnect.".to_string(),
            false,
        ),
        _ => (message.unwrap_or("ChatGPT couldn't answer. Please try again.").to_string(), false),
    };
    AskEvent::Failed {
        code: code.map(str::to_owned),
        message,
        usage_limited,
    }
}

/// Read a Responses API event stream, forwarding text as it arrives. An
/// answer counts only once `response.completed` is seen.
fn read_stream(reader: impl BufRead, started: Instant, mut send: impl FnMut(AskEvent)) -> Result<()> {
    let mut data = String::new();
    let mut first_word: Option<Duration> = None;
    let mut dispatch = |data: &str, send: &mut dyn FnMut(AskEvent)| -> Option<bool> {
        let event: Value = serde_json::from_str(data).ok()?;
        match event["type"].as_str()? {
            "response.output_text.delta" => {
                first_word.get_or_insert_with(|| started.elapsed());
                send(AskEvent::Delta {
                    text: event["delta"].as_str()?.to_owned(),
                });
                Some(false)
            }
            "response.completed" => {
                send(AskEvent::Completed {
                    tokens: Tokens::from_usage(&event["response"]["usage"]),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    first_word_ms: first_word.map(|d| d.as_millis() as u64),
                });
                Some(true)
            }
            "response.failed" => {
                let error = &event["response"]["error"];
                send(failure(error["code"].as_str(), error["message"].as_str()));
                Some(true)
            }
            "response.incomplete" => {
                send(failure(Some("incomplete"), Some("ChatGPT stopped before finishing the answer.")));
                Some(true)
            }
            "error" => {
                send(failure(event["code"].as_str(), event["message"].as_str()));
                Some(true)
            }
            _ => Some(false),
        }
    };
    for line in reader.lines() {
        let line = line.map_err(|_| "The answer stream was interrupted.".to_string())?;
        if line.is_empty() {
            if !data.is_empty() && dispatch(&data, &mut send) == Some(true) {
                return Ok(());
            }
            data.clear();
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    if !data.is_empty() && dispatch(&data, &mut send) == Some(true) {
        return Ok(());
    }
    send(failure(Some("incomplete"), Some("ChatGPT stopped before finishing the answer.")));
    Ok(())
}

/// Refresh-token errors that mean the sign-in is gone for good.
fn unusable(error: &str) -> bool {
    matches!(
        error,
        "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused"
    )
}

impl ChatGptState {
    pub fn new(app: tauri::AppHandle) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Could not start the ChatGPT client.".to_string())?;
        let streaming = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Could not start the ChatGPT client.".to_string())?;
        let state = Self {
            app,
            client,
            streaming,
            inner: Mutex::new(Inner::default()),
            refreshing: Mutex::new(()),
        };
        let saved = state
            .saved_path()
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        state.inner.lock().unwrap().saved = saved;
        Ok(state)
    }

    fn saved_path(&self) -> Result<PathBuf> {
        let dir = self
            .app
            .path()
            .app_config_dir()
            .map_err(|_| "Could not find the app's settings folder.".to_string())?;
        fs::create_dir_all(&dir).map_err(|_| "Could not create the app's settings folder.".to_string())?;
        Ok(dir.join(SAVED_FILE))
    }

    fn persist(&self, saved: &Saved) -> Result<()> {
        let path = self.saved_path()?;
        let text = serde_json::to_string_pretty(saved).map_err(|_| "Could not save the ChatGPT settings.".to_string())?;
        fs::write(&path, text).map_err(|_| "Could not save the ChatGPT settings.".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// This install's host ID, created and saved before its first sign-in.
    fn host_id(&self) -> Result<String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.saved.host_id.is_empty() {
            let mut saved = inner.saved.clone();
            saved.host_id = new_host_id()?;
            self.persist(&saved)?;
            inner.saved = saved;
        }
        Ok(inner.saved.host_id.clone())
    }

    pub fn view(&self) -> View {
        let inner = self.inner.lock().unwrap();
        let signed_in = inner.saved.client_id.is_some() && matches!(read_refresh(), Ok(Some(_)));
        View {
            status: if inner.pending.is_some() {
                Status::Pending
            } else if signed_in {
                Status::SignedIn
            } else {
                Status::SignedOut
            },
            email: signed_in.then(|| inner.saved.email.clone()).flatten(),
            error: inner.error.clone(),
        }
    }

    fn notify(&self) {
        let _ = self.app.emit(CHANGED, ());
    }

    fn fail(&self, error: String) {
        let mut inner = self.inner.lock().unwrap();
        inner.pending = None;
        inner.error = Some(error);
    }

    pub fn cancel(&self) {
        if let Some(pending) = self.inner.lock().unwrap().pending.take() {
            pending.close();
        }
    }

    pub async fn start(self: &Arc<Self>, window: tauri::Window) -> Result<View> {
        if self.inner.lock().unwrap().pending.is_some() {
            return Ok(self.view());
        }
        let host_id = self.host_id()?;
        let flow = tauri::async_runtime::spawn_blocking(loopback::Flow::bind)
            .await
            .map_err(|_| "Could not start sign-in listener.".to_string())??;
        let nonce = loopback::random()?;
        let redirect_uri = format!("http://127.0.0.1:{}{CALLBACK_PATH}", flow.port);
        let (client_id, login_hint) = {
            let inner = self.inner.lock().unwrap();
            (inner.saved.client_id.clone(), inner.saved.email.clone())
        };
        let url = authorize_url(
            client_id.as_deref(),
            login_hint.as_deref(),
            &host_id,
            &redirect_uri,
            flow.state(),
            &nonce,
            &loopback::challenge(&flow.verifier),
        )?;
        {
            let mut inner = self.inner.lock().unwrap();
            inner.pending = Some(flow.close_handle());
            inner.error = None;
        }
        if window.opener().open_url(url.as_str(), None::<&str>).is_err() {
            self.cancel();
            return Err("Could not open the browser. Please try again.".into());
        }

        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let worker = Arc::clone(&this);
            let result = tauri::async_runtime::spawn_blocking(move || {
                let (query, verifier, completion) = flow.receive(CALLBACK_PATH)?;
                if let Some(error) = loopback::single(&query, "error") {
                    completion.respond_page(false, "ChatGPT did not connect.");
                    return Err(if error == "access_denied" {
                        "ChatGPT sign-in was cancelled.".to_string()
                    } else {
                        "ChatGPT sign-in did not complete. Please try again.".to_string()
                    });
                }
                // A new registration names its issued client ID on the
                // callback; a returning sign-in may leave it out.
                let issued = loopback::single(&query, "client_id").map(str::to_owned).or(client_id);
                let (Some(code), Some(issued)) = (loopback::single(&query, "code"), issued) else {
                    completion.respond_page(false, "ChatGPT did not connect.");
                    return Err("ChatGPT sign-in did not complete. Please try again.".into());
                };
                match worker.exchange(code, &verifier, &redirect_uri, &issued, &nonce) {
                    Ok(()) => {
                        completion.respond_page(true, "ChatGPT is connected to zega.");
                        Ok(())
                    }
                    Err(error) => {
                        completion.respond_page(false, "ChatGPT did not connect.");
                        Err(error)
                    }
                }
            })
            .await
            .map_err(|_| "Sign-in listener aborted.".to_string())
            .and_then(|result| result);
            match result {
                Ok(()) => this.inner.lock().unwrap().pending = None,
                Err(error) => this.fail(error),
            }
            this.notify();
        });
        Ok(self.view())
    }

    fn exchange(&self, code: &str, verifier: &str, redirect_uri: &str, client_id: &str, nonce: &str) -> Result<()> {
        let response = self
            .client
            .post(TOKEN)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", redirect_uri),
                ("resource", RESOURCE),
            ])
            .send()
            .map_err(|_| "Could not reach ChatGPT to finish signing in. Check your connection.".to_string())?;
        if !response.status().is_success() {
            return Err("ChatGPT refused the sign-in. Please try again.".into());
        }
        let tokens: TokenResponse = response
            .json()
            .map_err(|_| "ChatGPT returned an unexpected sign-in response.".to_string())?;
        let refresh = tokens
            .refresh_token
            .ok_or_else(|| "ChatGPT did not grant offline access. Please try again.".to_string())?;
        let claims = match tokens.id_token.as_deref() {
            Some(id_token) => check_id_token(id_token, client_id, nonce, now_secs())?,
            None => Claims { email: None },
        };
        save_refresh(&refresh)?;
        let mut inner = self.inner.lock().unwrap();
        let mut saved = inner.saved.clone();
        saved.client_id = Some(client_id.to_owned());
        saved.email = claims.email;
        self.persist(&saved)?;
        inner.saved = saved;
        inner.access = Some(Access {
            token: Zeroizing::new(tokens.access_token),
            expires: Instant::now() + Duration::from_secs(tokens.expires_in),
        });
        Ok(())
    }

    /// A current access token, refreshing it when it is missing or about to
    /// lapse. `force` refreshes even a current one, after a 401.
    fn access_token(&self, force: bool) -> Result<Zeroizing<String>> {
        let _refreshing = self.refreshing.lock().unwrap();
        let client_id = {
            let inner = self.inner.lock().unwrap();
            if !force {
                if let Some(access) = &inner.access {
                    if access.expires > Instant::now() + EXPIRY_MARGIN {
                        return Ok(access.token.clone());
                    }
                }
            }
            inner.saved.client_id.clone()
        };
        let signed_out = || "Continue with ChatGPT to connect your plan.".to_string();
        let client_id = client_id.ok_or_else(signed_out)?;
        let refresh = read_refresh()?.ok_or_else(signed_out)?;
        let response = self
            .client
            .post(TOKEN)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id.as_str()),
                ("refresh_token", refresh.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .map_err(|_| "Could not reach ChatGPT. Check your connection.".to_string())?;
        if !response.status().is_success() {
            let error: Value = response.json().unwrap_or(Value::Null);
            if error["error"].as_str().is_some_and(unusable) {
                self.forget()?;
                self.notify();
                return Err("Your ChatGPT sign-in expired. Continue with ChatGPT to reconnect.".into());
            }
            return Err("ChatGPT is unavailable right now. Please try again.".into());
        }
        let tokens: TokenResponse = response
            .json()
            .map_err(|_| "ChatGPT returned an unexpected response.".to_string())?;
        if let Some(rotated) = &tokens.refresh_token {
            save_refresh(rotated)?;
        }
        let token = Zeroizing::new(tokens.access_token);
        self.inner.lock().unwrap().access = Some(Access {
            token: token.clone(),
            expires: Instant::now() + Duration::from_secs(tokens.expires_in),
        });
        Ok(token)
    }

    /// Drop this install's sign-in. The host ID stays; the issued client ID
    /// goes, so the next sign-in registers afresh for whoever signs in.
    fn forget(&self) -> Result<()> {
        clear_refresh()?;
        let mut inner = self.inner.lock().unwrap();
        inner.access = None;
        let mut saved = inner.saved.clone();
        saved.client_id = None;
        saved.email = None;
        self.persist(&saved)?;
        inner.saved = saved;
        Ok(())
    }

    pub fn disconnect(&self) -> Result<View> {
        self.cancel();
        let client_id = self.inner.lock().unwrap().saved.client_id.clone();
        if let (Some(client_id), Ok(Some(refresh))) = (client_id, read_refresh()) {
            // Best effort: the local sign-in is removed either way, and the
            // user can also revoke it from their ChatGPT settings.
            let _ = self
                .client
                .post(REVOKE)
                .form(&[
                    ("token", refresh.as_str()),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id.as_str()),
                ])
                .send();
        }
        self.forget()?;
        self.inner.lock().unwrap().error = None;
        self.notify();
        Ok(self.view())
    }

    pub fn models(&self) -> Result<Vec<Model>> {
        let mut forced = false;
        loop {
            let token = self.access_token(forced)?;
            let response = self
                .client
                .get(MODELS)
                .bearer_auth(token.as_str())
                .send()
                .map_err(|_| "Could not reach ChatGPT. Check your connection.".to_string())?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && !forced {
                forced = true;
                continue;
            }
            if !response.status().is_success() {
                return Err("Could not load ChatGPT's models. Please try again.".into());
            }
            let body: Value = response
                .json()
                .map_err(|_| "ChatGPT returned an unexpected model list.".to_string())?;
            return Ok(body["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|model| model["visibility"] == "list")
                .filter_map(|model| {
                    Some(Model {
                        slug: model["slug"].as_str()?.to_owned(),
                        display_name: model["display_name"].as_str()?.to_owned(),
                    })
                })
                .collect());
        }
    }

    pub fn ask(&self, question: &str, model: &str, send: impl FnMut(AskEvent)) -> Result<()> {
        let question = question.trim();
        if question.is_empty() || question.len() > MAX_QUESTION {
            return Err(format!("Ask a question of up to {MAX_QUESTION} characters."));
        }
        // Low reasoning effort: search answers should start in a second or
        // two, not after a long think. A model that refuses the setting
        // (`subscription_sharing_unsupported_capability`) is asked again
        // without it.
        let mut body = json!({
            "model": model,
            "input": [{ "role": "user", "content": question }],
            "store": false,
            "stream": true,
            "reasoning": { "effort": "low" },
        });
        let started = Instant::now();
        let mut forced = false;
        let mut plain = false;
        let response = loop {
            let token = self.access_token(forced)?;
            let response = self
                .streaming
                .post(RESPONSES)
                .bearer_auth(token.as_str())
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .json(&body)
                .send()
                .map_err(|_| "Could not reach ChatGPT. Check your connection.".to_string())?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && !forced {
                forced = true;
                continue;
            }
            if response.status() == reqwest::StatusCode::BAD_REQUEST && !plain {
                let error: Value = response.json().unwrap_or(Value::Null);
                if error["error"]["code"] == "subscription_sharing_unsupported_capability" {
                    plain = true;
                    if let Some(body) = body.as_object_mut() {
                        body.remove("reasoning");
                    }
                    continue;
                }
                let error = &error["error"];
                let mut send = send;
                send(failure(error["code"].as_str(), error["message"].as_str()));
                return Ok(());
            }
            break response;
        };
        let mut send = send;
        if !response.status().is_success() {
            let error: Value = response.json().unwrap_or(Value::Null);
            let error = &error["error"];
            send(failure(error["code"].as_str(), error["message"].as_str()));
            return Ok(());
        }
        read_stream(std::io::BufReader::new(response), started, |event| {
            if let AskEvent::Completed { tokens: Some(tokens), .. } = &event {
                // Counting must never cost the user their answer.
                let _ = self.record_usage(tokens);
            }
            send(event);
        })
    }

    fn usage_path(&self) -> Result<PathBuf> {
        Ok(self.saved_path()?.with_file_name(USAGE_FILE))
    }

    fn usage_log(&self) -> UsageLog {
        self.usage_path()
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn record_usage(&self, tokens: &Tokens) -> Result<()> {
        let _inner = self.inner.lock().unwrap();
        let mut log = self.usage_log();
        log.record(chrono::Local::now().date_naive(), tokens);
        let text = serde_json::to_string_pretty(&log).map_err(|_| "Could not save usage.".to_string())?;
        fs::write(self.usage_path()?, text).map_err(|_| "Could not save usage.".to_string())
    }

    pub fn usage(&self) -> UsageSummary {
        self.usage_log().summary(chrono::Local::now().date_naive())
    }
}

#[tauri::command]
pub fn chatgpt_status(state: State<'_, Arc<ChatGptState>>) -> View {
    state.view()
}

#[tauri::command]
pub async fn chatgpt_start(state: State<'_, Arc<ChatGptState>>, window: tauri::Window) -> Result<View> {
    let state = Arc::clone(&state);
    state.start(window).await
}

#[tauri::command]
pub fn chatgpt_cancel(state: State<'_, Arc<ChatGptState>>) -> View {
    state.cancel();
    state.view()
}

#[tauri::command]
pub async fn chatgpt_disconnect(state: State<'_, Arc<ChatGptState>>) -> Result<View> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.disconnect())
        .await
        .map_err(|_| "Could not disconnect ChatGPT.".to_string())?
}

#[tauri::command]
pub async fn chatgpt_models(state: State<'_, Arc<ChatGptState>>) -> Result<Vec<Model>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.models())
        .await
        .map_err(|_| "Could not load ChatGPT's models.".to_string())?
}

#[tauri::command]
pub fn chatgpt_usage(state: State<'_, Arc<ChatGptState>>) -> UsageSummary {
    state.usage()
}

#[tauri::command]
pub async fn chatgpt_ask(
    state: State<'_, Arc<ChatGptState>>,
    question: String,
    model: String,
    on_event: Channel<AskEvent>,
) -> Result<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.ask(&question, &model, |event| {
            let _ = on_event.send(event);
        })
    })
    .await
    .map_err(|_| "The answer was interrupted.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: Value) -> String {
        format!(
            "e30.{}.sig",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        )
    }

    fn query(url: &reqwest::Url, key: &str) -> Option<String> {
        url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }

    #[test]
    fn host_ids_are_version_4_uuid_urns() {
        let id = new_host_id().unwrap();
        let uuid = id.strip_prefix("urn:uuid:").unwrap();
        let parts: Vec<_> = uuid.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'));
        assert!(matches!(&parts[3][..1], "8" | "9" | "a" | "b"));
        assert_ne!(id, new_host_id().unwrap());
    }

    #[test]
    fn a_first_sign_in_registers_dynamically_and_names_the_app() {
        let url = authorize_url(None, Some("me@example.com"), "urn:uuid:x", "http://127.0.0.1:49200/auth/callback", "st", "no", "ch").unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://auth.openai.com");
        assert_eq!(url.path(), "/api/accounts/authorize");
        assert_eq!(query(&url, "client_id").as_deref(), Some(DYNAMIC_CLIENT));
        assert_eq!(query(&url, "agent_name_hint").as_deref(), Some("zega"));
        assert_eq!(query(&url, "login_hint"), None);
        assert_eq!(query(&url, "ext_agent_host_id").as_deref(), Some("urn:uuid:x"));
        assert_eq!(query(&url, "redirect_uri").as_deref(), Some("http://127.0.0.1:49200/auth/callback"));
        assert_eq!(query(&url, "scope").as_deref(), Some(SCOPE));
        assert_eq!(query(&url, "resource").as_deref(), Some(RESOURCE));
        assert_eq!(query(&url, "code_challenge_method").as_deref(), Some("S256"));
        assert_eq!(query(&url, "code_challenge").as_deref(), Some("ch"));
        assert_eq!(query(&url, "state").as_deref(), Some("st"));
        assert_eq!(query(&url, "nonce").as_deref(), Some("no"));
    }

    #[test]
    fn a_returning_sign_in_reuses_the_issued_client_without_the_name_hint() {
        let url = authorize_url(Some("app_123"), Some("me@example.com"), "urn:uuid:x", "http://127.0.0.1:49200/auth/callback", "st", "no", "ch").unwrap();
        assert_eq!(query(&url, "client_id").as_deref(), Some("app_123"));
        assert_eq!(query(&url, "agent_name_hint"), None);
        assert_eq!(query(&url, "login_hint").as_deref(), Some("me@example.com"));
    }

    #[test]
    fn id_tokens_must_match_this_client_attempt_and_time() {
        let good = json!({"iss": ISSUER, "aud": "app_1", "nonce": "n1", "exp": 2000, "email": "me@example.com"});
        assert_eq!(check_id_token(&jwt(good.clone()), "app_1", "n1", 1000).unwrap(), Claims { email: Some("me@example.com".into()) });
        let mut listed = good.clone();
        listed["aud"] = json!(["other", "app_1"]);
        assert!(check_id_token(&jwt(listed), "app_1", "n1", 1000).is_ok());
        assert!(check_id_token(&jwt(good.clone()), "app_2", "n1", 1000).is_err(), "another client's token");
        assert!(check_id_token(&jwt(good.clone()), "app_1", "n2", 1000).is_err(), "another attempt's nonce");
        assert!(check_id_token(&jwt(good.clone()), "app_1", "n1", 2000).is_err(), "expired");
        let mut issuer = good;
        issuer["iss"] = json!("https://evil.example");
        assert!(check_id_token(&jwt(issuer), "app_1", "n1", 1000).is_err(), "another issuer");
        assert!(check_id_token("not-a-jwt", "app_1", "n1", 1000).is_err());
    }

    fn stream(text: &str) -> Vec<AskEvent> {
        let mut events = Vec::new();
        read_stream(std::io::Cursor::new(text.to_owned()), Instant::now(), |event| events.push(event)).unwrap();
        events
    }

    #[test]
    fn streamed_text_arrives_in_order_and_ends_on_completed() {
        let events = stream(concat!(
            "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":120,\"input_tokens_details\":{\"cached_tokens\":100},\"output_tokens\":30,\"output_tokens_details\":{\"reasoning_tokens\":12},\"total_tokens\":150}}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"after\"}\n\n",
        ));
        assert_eq!(events[..2], [AskEvent::Delta { text: "Hel".into() }, AskEvent::Delta { text: "lo".into() }]);
        let [_, _, AskEvent::Completed { tokens, first_word_ms, .. }] = &events[..] else {
            panic!("expected two deltas then completed, got {events:?}");
        };
        assert_eq!(*tokens, Some(Tokens { input: 120, cached_input: 100, output: 30, reasoning: 12 }));
        assert!(first_word_ms.is_some());
    }

    #[test]
    fn usage_totals_roll_up_by_day_and_forget_old_days() {
        let day = |d: &str| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap();
        let tokens = Tokens { input: 100, output: 20, ..Tokens::default() };
        let mut log = UsageLog::default();
        log.record(day("2026-07-01"), &tokens);
        log.record(day("2026-09-24"), &tokens);
        log.record(day("2026-09-29"), &tokens);
        log.record(day("2026-09-29"), &tokens);
        let summary = log.summary(day("2026-09-29"));
        assert_eq!(summary.today, Totals { answers: 2, input: 200, output: 40 });
        assert_eq!(summary.last_7_days, Totals { answers: 3, input: 300, output: 60 });
        assert_eq!(summary.all_time, Totals { answers: 4, input: 400, output: 80 });
        assert!(!log.days.contains_key("2026-07-01"), "days past the window fold into all-time only");
    }

    #[test]
    fn a_usage_limit_offers_manage_usage() {
        let events = stream("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"limit\"}}}\n\n");
        assert!(matches!(&events[..], [AskEvent::Failed { usage_limited: true, .. }]));
    }

    #[test]
    fn a_stream_that_stops_early_is_not_an_answer() {
        let events = stream("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n");
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[1], AskEvent::Failed { code: Some(code), .. } if code == "incomplete"));
    }

    #[test]
    fn only_dead_refresh_tokens_end_the_sign_in() {
        assert!(unusable("invalid_grant"));
        assert!(unusable("refresh_token_reused"));
        assert!(!unusable("temporarily_unavailable"));
    }
}
