//! Browser loopback sign-in for the zega desktop shell.
//!
//! Only safe display data (name, avatar) crosses Tauri IPC. The bearer token
//! lives only in the macOS keychain (or the platform equivalent). A slimmed
//! port of the proven cqxai/desktop auth flow, confirmed route-for-route
//! against zegadb/id (app/auth/desktop/*, app/auth/me, app/auth/signout).

use crate::loopback;
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

// zegadb/id's canonical host (its wrangler.jsonc custom_domain; legacy
// id.zega.dev and account.zega.earth only 301 there — neither is attached
// to the worker as itself). Its /auth/desktop, /auth/desktop/token,
// /auth/me and /auth/signout routes are the other half of this contract.
pub const IDENTITY_ORIGIN: &str = "https://account.zega.dev";
// Earth API origin. No authenticated API calls yet; reserved for when the
// shell fetches account-scoped site data.
const KEYCHAIN: Keychain = Keychain {
    service: "earth.zega.desktop",
    user: "zega-desktop-session",
};

type Result<T> = std::result::Result<T, String>;

trait Vault: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<String>>>;
    fn save(&self, token: &str) -> Result<()>;
    fn clear(&self) -> Result<()>;
}

#[derive(Clone, Copy)]
struct Keychain {
    service: &'static str,
    user: &'static str,
}

impl Keychain {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(self.service, self.user)
            .map_err(|_| "Cannot open the OS keychain. Unlock it and retry.".into())
    }
}

impl Vault for Keychain {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(Zeroizing::new(token))),
            Err(keyring::Error::NoEntry) => Ok(None),
            // Do not format keyring errors: BadEncoding can contain the secret.
            Err(_) => Err("Cannot read the OS keychain. Unlock it and retry.".into()),
        }
    }

    fn save(&self, token: &str) -> Result<()> {
        self.entry()?
            .set_password(token)
            .map_err(|_| "Cannot save sign-in in the OS keychain. Unlock it and retry.".into())
    }

    fn clear(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("The session is revoked, but its OS keychain entry could not be removed. Unlock it and retry.".into()),
        }
    }
}

#[derive(Clone, Default, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    SignedOut,
    Pending,
    Expired,
    SignedIn,
    Unavailable,
}

#[derive(Clone, Default, Deserialize, Serialize, Debug)]
#[serde(default)]
pub struct Identity {
    pub account: u64,
    pub login: Option<String>,
    pub name: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Clone, Default, Serialize, Debug)]
pub struct View {
    pub status: Status,
    pub awaiting_browser: bool,
    pub identity: Option<Identity>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct Token {
    token: String,
}

#[derive(Deserialize)]
struct Me {
    #[serde(rename = "signedIn")]
    signed_in: bool,
    // /auth/me answers {signedIn: false} with no identity fields when the
    // token is unknown; `default` makes that deserialize to Identity::default
    // instead of an error, so an unknown token reads as signed out.
    #[serde(flatten)]
    identity: Identity,
}

struct Pending {
    closer: loopback::CloseHandle,
}

#[derive(Default)]
struct Inner {
    view: View,
    pending: Option<Pending>,
}

pub struct AccountState {
    client: reqwest::blocking::Client,
    vault: Arc<dyn Vault>,
    inner: Mutex<Inner>,
    app: tauri::AppHandle,
}

impl AccountState {
    pub fn new(app: tauri::AppHandle) -> Result<Self> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not initialize account networking.".to_string())?,
            vault: Arc::new(KEYCHAIN),
            inner: Mutex::default(),
            app,
        })
    }

    fn view(&self) -> View {
        self.inner.lock().unwrap().view.clone()
    }

    fn replace(&self, view: View) -> View {
        let mut inner = self.inner.lock().unwrap();
        inner.pending = None;
        inner.view = view.clone();
        view
    }

    pub fn cancel(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(pending) = inner.pending.take() {
            pending.closer.close();
        }
        if matches!(inner.view.status, Status::Pending) {
            inner.view = View::default();
        }
    }

    fn notify(&self) {
        let _ = self.app.emit("account-changed", ());
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::blocking::RequestBuilder {
        self.client
            .request(method, format!("{IDENTITY_ORIGIN}{path}"))
    }

    fn exchange(&self, code: &str, verifier: &str) -> Result<Zeroizing<String>> {
        let response = self
            .request(reqwest::Method::POST, "/auth/desktop/token")
            .json(&serde_json::json!({ "code": code, "verifier": verifier }))
            .send()
            .map_err(|_| "Cannot reach zega identity. Check your connection and retry.".to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("zega identity returned HTTP {status}. Please retry."));
        }
        let token = response
            .json::<Token>()
            .map_err(|_| "zega identity returned an unreadable response. Please retry.".to_string())?
            .token;
        if token.is_empty() || token.len() > 512 {
            return Err("zega identity returned an invalid session. Please retry.".into());
        }
        Ok(Zeroizing::new(token))
    }

    /// Returns Ok(None) when the token is no longer valid (HTTP 401/403):
    /// the vault entry is stale and the caller should treat it as signed out.
    fn me(&self, token: &str) -> Result<Option<Me>> {
        let response = self.request(reqwest::Method::GET, "/auth/me")
            .bearer_auth(token)
            .send()
            .map_err(|_| "Cannot reach zega identity. Check your connection and retry.".to_string())?;
        if matches!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) {
            return Ok(None);
        }
        response
            .error_for_status()
            .map_err(|e| format!("zega identity returned HTTP {}. Please retry.", e.status().unwrap_or_default()))?
            .json()
            .map(Some)
            .map_err(|_| "zega identity returned an unreadable response. Please retry.".to_string())
    }

    fn revoke(&self, token: &str) -> Result<()> {
        self.request(reqwest::Method::POST, "/auth/signout")
            .bearer_auth(token)
            .send()
            .map_err(|_| "Cannot reach zega identity to sign out.".to_string())?
            .error_for_status()
            .map_err(|e| format!("Sign-out returned HTTP {}.", e.status().unwrap_or_default()))?;
        Ok(())
    }

    fn identify(&self, token: &str) -> Result<View> {
        let Some(me) = self.me(token)? else {
            // Token rejected: drop the stale vault entry and report signed out.
            let _ = self.vault.clear();
            return Ok(self.replace(View::default()));
        };
        if !me.signed_in {
            let _ = self.vault.clear();
            return Ok(self.replace(View::default()));
        }
        if me.identity.account == 0 {
            return Err("zega identity did not return the account. Please retry.".into());
        }
        Ok(self.replace(View {
            status: Status::SignedIn,
            identity: Some(me.identity),
            ..View::default()
        }))
    }

    pub fn status(&self) -> Result<View> {
        match self.vault.read() {
            Ok(Some(token)) => self.identify(&token),
            Ok(None) => Ok(self.replace(View::default())),
            Err(error) => Err(error),
        }
    }

    pub async fn start(self: &Arc<Self>, window: tauri::Window) -> Result<View> {
        // Serialize against status/signout and guard against multiple starts.
        {
            let inner = self.inner.lock().unwrap();
            if inner.pending.is_some() || matches!(inner.view.status, Status::SignedIn) {
                return Ok(inner.view.clone());
            }
        }

        let flow = tauri::async_runtime::spawn_blocking(loopback::Flow::bind)
            .await
            .map_err(|_| "Could not start sign-in listener.".to_string())??;
        let uri = flow.browser_uri();
        let closer = flow.close_handle();

        {
            let mut inner = self.inner.lock().unwrap();
            inner.pending = Some(Pending { closer });
            inner.view = View {
                status: Status::Pending,
                awaiting_browser: true,
                ..View::default()
            };
        }

        // Open the browser. The listener is already running, so the user can
        // complete the flow even if the OS takes a moment to launch the app.
        if window.opener().open_url(&uri, None::<&str>).is_err() {
            self.cancel();
            return Err("Could not open the browser. Please try signing in again.".into());
        }

        // Wait for the browser callback on a blocking thread so the async
        // runtime stays free for other IPC.
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let callback = tauri::async_runtime::spawn_blocking(|| flow.callback())
                .await
                .map_err(|_| "Sign-in listener aborted.".to_string())
                .and_then(|r| r);

            let (code, verifier, completion) = match callback {
                Ok(pair) => pair,
                Err(error) => {
                    this.replace(View {
                        status: Status::Expired,
                        error: Some(error),
                        ..View::default()
                    });
                    this.notify();
                    return;
                }
            };

            this.inner.lock().unwrap().pending = None;

            // Exchange the one-time code for a session token.
            let result = this.exchange(&code, &verifier);
            drop(code);
            drop(verifier);

            match result {
                Ok(token) => {
                    if let Err(error) = this.vault.save(&token) {
                        let _ = this.revoke(&token);
                        completion.respond(false);
                        this.replace(View {
                            error: Some(error),
                            ..View::default()
                        });
                    } else {
                        completion.respond(true);
                        if let Err(error) = this.identify(&token) {
                            this.replace(View {
                                status: Status::Unavailable,
                                error: Some(error),
                                ..View::default()
                            });
                        }
                    }
                }
                Err(error) => {
                    completion.respond(false);
                    this.replace(View {
                        error: Some(error),
                        ..View::default()
                    });
                }
            }
            this.notify();
        });

        Ok(self.view())
    }

    pub fn signout(&self) -> Result<View> {
        self.cancel();
        let result = (|| -> Result<()> {
            if let Some(token) = self.vault.read()? {
                self.revoke(&token)?;
            }
            self.vault.clear()?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                let view = self.replace(View::default());
                self.notify();
                Ok(view)
            }
            Err(error) => Err(format!("Sign-out did not finish. {error}")),
        }
    }
}

#[tauri::command]
pub fn account_status(state: State<'_, Arc<AccountState>>) -> Result<View> {
    state.status()
}

#[tauri::command]
pub async fn account_start(
    window: tauri::Window,
    state: State<'_, Arc<AccountState>>,
) -> Result<View> {
    state.start(window).await
}

#[tauri::command]
pub fn account_cancel(state: State<'_, Arc<AccountState>>) -> View {
    state.cancel();
    state.view()
}

#[tauri::command]
pub fn account_signout(state: State<'_, Arc<AccountState>>) -> Result<View> {
    state.signout()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The exact shapes zegadb/id's /auth/me returns (see app/auth/me/route.ts
    // and the live run in this PR's body): an unknown token must read as
    // signed out, not as an unreadable response.
    #[test]
    fn me_parses_signed_out_without_identity_fields() {
        let me: Me = serde_json::from_str(r#"{"signedIn":false}"#).unwrap();
        assert!(!me.signed_in);
        assert_eq!(me.identity.account, 0);
        assert_eq!(me.identity.name, None);
    }

    #[test]
    fn me_parses_signed_in_with_identity() {
        let me: Me = serde_json::from_str(
            r#"{"signedIn":true,"account":42,"login":"octocat","name":"Octo Cat","avatar":"https://avatars.githubusercontent.com/u/42"}"#,
        )
        .unwrap();
        assert!(me.signed_in);
        assert_eq!(me.identity.account, 42);
        assert_eq!(me.identity.login.as_deref(), Some("octocat"));
        assert_eq!(me.identity.name.as_deref(), Some("Octo Cat"));
        assert_eq!(
            me.identity.avatar.as_deref(),
            Some("https://avatars.githubusercontent.com/u/42")
        );
    }

    #[test]
    fn token_parses_the_redeem_response() {
        let token: Token = serde_json::from_str(r#"{"token":"abc123"}"#).unwrap();
        assert_eq!(token.token, "abc123");
    }
}
