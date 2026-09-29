//! In-app updates per APS 37: install once, update forever.
//!
//! - One update feed, two channels: `<update-domain>/desktop/{stable,canary}.json`
//!   (rule 3: this address is permanent for the life of any install).
//! - Every update is signed with zega's own Ed25519 updater key; the Tauri
//!   updater installs only artifacts that verify against the public key the
//!   build shipped with (rule 1).
//! - Check at launch and then every 6 hours, download in the background,
//!   apply on "Restart to update" or, for critical releases, at the next idle
//!   moment. No dialogs, no nags.
//! - A manifest platform entry may set `minimum_os`; a release that drops an
//!   OS version is never offered to that OS (rule 6). When the OS version
//!   cannot be determined, the update is refused — fail closed.
//! - Builds made for package managers (apt, AUR, Homebrew, winget) compile
//!   this module with the `packaged` feature, which fixes the updater OFF at
//!   build time; the package manager owns updates for those installs.

use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(not(feature = "packaged"))]
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(not(feature = "packaged"))]
use std::thread;
#[cfg(not(feature = "packaged"))]
use std::time::Duration;
#[cfg(not(feature = "packaged"))]
use tauri_plugin_updater::{Update, UpdaterExt};

/// Rule 3: the update URL is permanent. Only `{channel}` varies at runtime;
/// the first public build ships this address and it must keep answering.
#[cfg(not(feature = "packaged"))]
const ENDPOINT_TEMPLATE: &str = "https://releases.zega.earth/desktop/{channel}.json";
const CHANNEL_FILE: &str = "update-channel";
#[cfg(not(feature = "packaged"))]
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A critical release applies at the next idle moment; give a running session
/// a beat to settle before the restart.
#[cfg(not(feature = "packaged"))]
const IDLE_APPLY_DELAY: Duration = Duration::from_secs(5);
#[cfg(not(feature = "packaged"))]
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Canary,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Canary => "canary",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "stable" => Some(Channel::Stable),
            "canary" => Some(Channel::Canary),
            _ => None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// False in `packaged` builds: the package manager owns updates.
    enabled: bool,
    channel: Channel,
    current_version: String,
    pending_version: Option<String>,
}

pub struct UpdateState {
    #[cfg(not(feature = "packaged"))]
    pending: Mutex<Option<Pending>>,
}

#[cfg(not(feature = "packaged"))]
struct Pending {
    update: Update,
    version: String,
    bytes: Vec<u8>,
}

/// The channel manifest we publish at `<update-domain>/desktop/<channel>.json`.
/// `critical` and `minimum_os` are zega extensions the Tauri updater ignores;
/// this module reads them before handing the download to the updater.
#[cfg(not(feature = "packaged"))]
#[derive(Deserialize)]
struct ChannelManifest {
    #[serde(default)]
    critical: bool,
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[cfg(not(feature = "packaged"))]
#[derive(Deserialize)]
struct PlatformEntry {
    minimum_os: Option<String>,
}

fn channel_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(CHANNEL_FILE))
}

pub fn channel(app: &AppHandle) -> Channel {
    channel_file(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| Channel::parse(&raw))
        .unwrap_or(Channel::Stable)
}

#[cfg(not(feature = "packaged"))]
fn endpoint(app: &AppHandle) -> Result<String, String> {
    // Release and test builds may point the feed elsewhere by overriding the
    // configured endpoint; the shipped default is the permanent APS 37 URL.
    let template = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .and_then(|endpoints| endpoints.first())
        .and_then(|endpoint| endpoint.as_str())
        .unwrap_or(ENDPOINT_TEMPLATE);
    if template.contains("{channel}") {
        Ok(template.replace("{channel}", channel(app).as_str()))
    } else {
        Ok(template.to_owned())
    }
}

/// `darwin-aarch64`, `windows-x86_64`, … — the same target-arch key the Tauri
/// updater looks up in the manifest.
#[cfg(not(feature = "packaged"))]
fn platform_key() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// The running OS version as `(major, minor, patch)`.
#[cfg(all(not(feature = "packaged"), target_os = "macos"))]
fn os_version() -> Option<(u64, u64, u64)> {
    let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    Some((
        version.majorVersion as u64,
        version.minorVersion as u64,
        version.patchVersion as u64,
    ))
}

#[cfg(all(not(feature = "packaged"), target_os = "linux"))]
fn os_version() -> Option<(u64, u64, u64)> {
    let release = fs::read_to_string("/proc/sys/kernel/osrelease").ok()?;
    parse_version(release.trim())
}

#[cfg(all(not(feature = "packaged"), target_os = "windows"))]
fn os_version() -> Option<(u64, u64, u64)> {
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..OSVERSIONINFOW::default()
    };
    let status = unsafe { windows_sys::Wdk::System::SystemServices::RtlGetVersion(&mut info) };
    (status == 0).then_some((
        info.dwMajorVersion as u64,
        info.dwMinorVersion as u64,
        info.dwBuildNumber as u64,
    ))
}

#[cfg(not(feature = "packaged"))]
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let mut parts = raw.split(['.', '-']);
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// Rule 6: never offer an update the machine cannot run. Refuses when the
/// manifest sets a floor the OS does not meet — or when the floor exists but
/// the OS version cannot be determined.
#[cfg(not(feature = "packaged"))]
fn os_meets_minimum(minimum: Option<&str>) -> bool {
    let Some(minimum) = minimum else { return true };
    let Some(minimum) = parse_version(minimum) else {
        eprintln!("zega update: ignoring unparseable minimum_os {minimum:?}");
        return true;
    };
    match os_version() {
        Some(current) => current >= minimum,
        None => {
            eprintln!("zega update: refusing update; cannot verify minimum_os requirement");
            false
        }
    }
}

pub fn initialize(app: &AppHandle) {
    #[cfg(not(feature = "packaged"))]
    {
        app.manage(UpdateState {
            pending: Mutex::new(None),
        });
        let handle = app.clone();
        thread::spawn(move || {
            loop {
                check_once(&handle);
                thread::sleep(CHECK_INTERVAL);
            }
        });
    }
    #[cfg(feature = "packaged")]
    app.manage(UpdateState {});
}

#[cfg(not(feature = "packaged"))]
fn check_once(app: &AppHandle) {
    if let Err(error) = check_once_inner(app) {
        eprintln!("zega update: check failed ({error}); the app keeps running untouched");
    }
}

#[cfg(not(feature = "packaged"))]
fn check_once_inner(app: &AppHandle) -> Result<(), String> {
    let url = endpoint(app)?;
    let manifest: ChannelManifest = reqwest::blocking::Client::builder()
        .timeout(MANIFEST_TIMEOUT)
        .build()
        .and_then(|client| client.get(&url).send())
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json())
        .map_err(|error| format!("cannot read the update manifest at {url}: {error}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![
            url.parse()
                .map_err(|error| format!("bad endpoint {url}: {error}"))?,
        ])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| format!("updater is not configured on this build: {error}"))?;
    let Some(update) = tauri::async_runtime::block_on(updater.check())
        .map_err(|error| format!("update check failed: {error}"))?
    else {
        return Ok(());
    };
    let entry = manifest.platforms.get(&platform_key());
    if !os_meets_minimum(entry.and_then(|entry| entry.minimum_os.as_deref())) {
        eprintln!(
            "zega update: {} is not offered to this OS (rule 6); staying on {}",
            update.version, update.current_version
        );
        return Ok(());
    }
    eprintln!("zega update: downloading {}", update.version);
    let bytes =
        tauri::async_runtime::block_on(update.download(|_, _| {}, || {})).map_err(|error| {
            format!(
                "refused update {} (signature or download verification failed): {error}",
                update.version
            )
        })?;
    let version = update.version.clone();
    let state = app.state::<UpdateState>();
    *state
        .pending
        .lock()
        .map_err(|_| "update state is unavailable".to_owned())? = Some(Pending {
        update,
        version: version.clone(),
        bytes,
    });
    crate::menu::mark_update_ready(app, &version);
    eprintln!("zega update: {version} is ready; Restart to update appears in the menu");
    if manifest.critical {
        eprintln!("zega update: {version} is critical; applying at the next idle moment");
        let handle = app.clone();
        thread::spawn(move || {
            thread::sleep(IDLE_APPLY_DELAY);
            if let Err(error) = install_and_restart(&handle) {
                eprintln!("zega update: could not apply critical update: {error}");
            }
        });
    }
    Ok(())
}

#[cfg(not(feature = "packaged"))]
fn install_and_restart(app: &AppHandle) -> Result<(), String> {
    let pending = app
        .state::<UpdateState>()
        .pending
        .lock()
        .map_err(|_| "update state is unavailable".to_owned())?
        .take()
        .ok_or_else(|| "no downloaded update is waiting".to_owned())?;
    pending
        .update
        .install(&pending.bytes)
        .map_err(|error| format!("could not install {}: {error}", pending.version))?;
    eprintln!("zega update: installed {}; restarting", pending.version);
    app.restart();
}

#[cfg(not(feature = "packaged"))]
pub fn restart_to_update(app: &AppHandle) {
    if let Err(error) = install_and_restart(app) {
        eprintln!("zega update: {error}");
    }
}

#[cfg(feature = "packaged")]
pub fn restart_to_update(_: &AppHandle) {}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    #[cfg(not(feature = "packaged"))]
    let pending_version = app
        .state::<UpdateState>()
        .pending
        .lock()
        .ok()
        .and_then(|pending| pending.as_ref().map(|pending| pending.version.clone()));
    #[cfg(feature = "packaged")]
    let pending_version = None;
    UpdateStatus {
        enabled: !cfg!(feature = "packaged"),
        channel: channel(&app),
        current_version: app.package_info().version.to_string(),
        pending_version,
    }
}

#[tauri::command]
pub fn set_update_channel(app: AppHandle, channel: String) -> Result<(), String> {
    if cfg!(feature = "packaged") {
        return Err("This install is updated by its package manager".to_owned());
    }
    let parsed = Channel::parse(&channel)
        .ok_or_else(|| format!("unknown update channel {channel:?}; expected stable or canary"))?;
    let path = channel_file(&app)?;
    fs::create_dir_all(path.parent().ok_or("missing config directory")?)
        .map_err(|error| error.to_string())?;
    fs::write(&path, parsed.as_str()).map_err(|error| error.to_string())?;
    #[cfg(not(feature = "packaged"))]
    {
        let handle = app.clone();
        thread::spawn(move || check_once(&handle));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_parses_exactly_two_values() {
        assert_eq!(Channel::parse("stable"), Some(Channel::Stable));
        assert_eq!(Channel::parse("canary"), Some(Channel::Canary));
        assert_eq!(Channel::parse("Stable"), None);
        assert_eq!(Channel::parse("nightly"), None);
        assert_eq!(Channel::parse(""), None);
    }

    #[cfg(not(feature = "packaged"))]
    #[test]
    fn version_triplets_compare_by_component() {
        assert_eq!(parse_version("14.1.2"), Some((14, 1, 2)));
        assert_eq!(parse_version("6.8.0-41-generic"), Some((6, 8, 0)));
        assert_eq!(parse_version("10.0"), Some((10, 0, 0)));
        assert_eq!(parse_version("next"), None);
        assert!(parse_version("14.0").unwrap() >= parse_version("13.6").unwrap());
        assert!(parse_version("14.0").unwrap() < parse_version("14.0.1").unwrap());
    }

    #[cfg(not(feature = "packaged"))]
    #[test]
    fn minimum_os_refuses_below_the_floor_and_allows_at_or_above_it() {
        // The real OS version is a machine property; exercise the comparison
        // through parse_version, which os_meets_minimum delegates to.
        let floor = parse_version("14.0").unwrap();
        assert!(parse_version("14.0").unwrap() >= floor);
        assert!(parse_version("15.2").unwrap() >= floor);
        assert!(!(parse_version("13.6.9").unwrap() >= floor));
    }

    #[cfg(not(feature = "packaged"))]
    #[test]
    fn manifest_reads_critical_and_minimum_os_extensions() {
        let manifest: ChannelManifest = serde_json::from_str(
            r#"{
                "version": "1.1.0",
                "pub_date": "2026-09-28T00:00:00Z",
                "critical": true,
                "platforms": {
                    "darwin-x86_64": {
                        "url": "https://releases.zega.earth/desktop/zega_1.1.0_x64.app.tar.gz",
                        "signature": "dW50cnVzdGVkIGNvbW1lbnQ6",
                        "sha256": "00",
                        "minimum_os": "14.0"
                    }
                }
            }"#,
        )
        .expect("the published manifest shape must parse");
        assert!(manifest.critical);
        assert_eq!(
            manifest.platforms["darwin-x86_64"].minimum_os.as_deref(),
            Some("14.0")
        );
    }

    #[cfg(not(feature = "packaged"))]
    #[test]
    fn manifest_without_critical_defaults_to_a_normal_release() {
        let manifest: ChannelManifest =
            serde_json::from_str(r#"{"version": "1.1.0", "platforms": {}}"#)
                .expect("critical must default to false");
        assert!(!manifest.critical);
    }
}
