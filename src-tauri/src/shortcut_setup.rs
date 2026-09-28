//! Registration, native delivery, and user confirmation are separate facts.
use crate::shortcut_config::Binding;
use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    binding: Binding,
    label: String,
    platform: &'static str,
    square_corners: bool,
    portal: bool,
    registered: bool,
    error: Option<String>,
    phase: Phase,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Waiting,
    Received,
    Confirmed,
    Expired,
}

struct Setup {
    status: Status,
    started: Option<Instant>,
    path: PathBuf,
}
pub struct ShortcutState(Mutex<Setup>);
#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
struct PortalState(tokio::sync::Mutex<Option<crate::shortcut_portal::Registration>>);

fn uses_portal() -> bool {
    #[cfg(target_os = "linux")]
    {
        use gdk::prelude::*;
        gdk::Display::default().is_some_and(|display| display.type_().name().contains("Wayland"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

impl Setup {
    fn begin(&mut self) -> Result<(), String> {
        if !self.status.registered {
            return Err("Choose an available shortcut first.".into());
        }
        self.status.error = None;
        self.status.phase = Phase::Waiting;
        self.started = Some(Instant::now());
        Ok(())
    }
    fn received(&mut self, outside_zega: bool) {
        if !outside_zega {
            self.status.phase = Phase::Idle;
            self.status.error = Some(
                "Switch to another app before pressing the shortcut, then retry the test.".into(),
            );
            return;
        }
        if self.status.phase == Phase::Waiting {
            self.status.phase = if self
                .started
                .is_some_and(|at| at.elapsed() <= Duration::from_secs(30))
            {
                Phase::Received
            } else {
                Phase::Expired
            };
        }
    }
    fn save(&self) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or("Shortcut settings folder is unavailable")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let staging = self.path.with_extension("json.new");
        fs::write(
            &staging,
            serde_json::to_vec(&self.status.binding).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(staging, &self.path).map_err(|e| e.to_string())
    }
    fn confirm(&mut self) -> Result<(), String> {
        if self.status.phase != Phase::Received {
            return Err("Press the shortcut during a test before confirming it.".into());
        }
        self.status.phase = Phase::Confirmed;
        Ok(())
    }
}

pub fn initialize(app: &AppHandle) -> Result<bool, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("launcher-shortcut.json");
    let exists = path.exists();
    let use_default = std::env::args().any(|arg| arg == "--default-shortcut");
    let loaded = if exists && !use_default {
        fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice::<Binding>(&bytes).map_err(|e| e.to_string()))
    } else {
        Ok(Binding::default())
    };
    let (binding, load_error) = match loaded {
        Ok(binding) => (binding, None),
        Err(error) => (
            Binding::default(),
            Some(format!(
                "Could not read your saved shortcut: {error}. Choose and save a shortcut again."
            )),
        ),
    };
    #[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
    app.manage(PortalState(tokio::sync::Mutex::new(None)));
    let registration = binding.validate().and_then(|()| install(app, &binding));
    let status = Status {
        label: binding.label(),
        binding,
        platform: std::env::consts::OS,
        square_corners: cfg!(target_os = "linux")
            && std::path::Path::new("/usr/share/omarchy").is_dir(),
        portal: uses_portal(),
        registered: registration.is_ok(),
        error: load_error.or(registration.err()),
        phase: Phase::Idle,
    };
    let needs_setup = !exists || status.error.is_some();
    app.manage(ShortcutState(Mutex::new(Setup {
        status,
        started: None,
        path,
    })));
    #[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
    if uses_portal() && (exists || use_default) {
        let handle = app.clone();
        let binding = shortcut_status(app.state())?.binding;
        tauri::async_runtime::spawn(async move {
            let _ = shortcut_apply(handle, binding).await;
        });
    }
    if use_default && !uses_portal() {
        let state = app.state::<ShortcutState>();
        let mut setup = state.0.lock().map_err(|e| e.to_string())?;
        if setup.status.registered {
            if let Err(error) = setup.save() {
                setup.status.error = Some(error);
            }
        }
    }
    Ok(needs_setup || use_default)
}

pub fn apply_default(app: AppHandle) {
    let _ = show_shortcut_setup(app.clone());
    tauri::async_runtime::spawn(async move {
        let _ = shortcut_apply(app, Binding::default()).await;
    });
}

#[cfg(target_os = "macos")]
fn install(app: &AppHandle, binding: &Binding) -> Result<(), String> {
    crate::shortcut::uninstall();
    crate::shortcut::install(app, binding)
}
#[cfg(not(target_os = "macos"))]
fn install(app: &AppHandle, binding: &Binding) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    if uses_portal() {
        return Err("Choose Save & test to request your desktop shortcut.".into());
    }
    if app
        .try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>()
        .is_none()
    {
        app.plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .map_err(|error| format!("Global shortcuts are unavailable on this desktop ({error}). Use Open search below."))?;
    }
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    app.global_shortcut().on_shortcut(binding.accelerator().as_str(), |app, _, event| {
        if event.state == ShortcutState::Pressed { activated(app); }
    }).map_err(|error| format!("{} is unavailable ({error}). Another app or the desktop may reserve it. Choose another combination or change the conflicting binding, then retry.", binding.label()))
}

#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
fn portal_changed(app: &AppHandle, label: Option<String>) {
    if let Ok(mut setup) = app.state::<ShortcutState>().0.lock() {
        setup.status.phase = Phase::Idle;
        match label {
            Some(label) => {
                setup.status.label = label;
            }
            None => {
                setup.status.registered = false;
                setup.status.error = Some(
                    "Desktop shortcut access ended. Retry setup; click-to-open remains available."
                        .into(),
                );
            }
        }
        let _ = app.emit("shortcut-status", &setup.status);
    }
}

#[tauri::command]
pub fn shortcut_status(state: State<'_, ShortcutState>) -> Result<Status, String> {
    let mut setup = state.0.lock().map_err(|e| e.to_string())?;
    if setup.status.phase == Phase::Waiting
        && setup
            .started
            .is_some_and(|at| at.elapsed() > Duration::from_secs(30))
    {
        setup.status.phase = Phase::Expired;
    }
    Ok(setup.status.clone())
}

#[tauri::command]
pub async fn shortcut_apply(app: AppHandle, binding: Binding) -> Result<Status, String> {
    binding.validate()?;
    #[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
    let portal_result = {
        let is_portal = app
            .state::<ShortcutState>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .status
            .portal;
        if is_portal {
            #[cfg(target_os = "linux")]
            let gnome = crate::gnome_shortcut::available().await;
            #[cfg(not(target_os = "linux"))]
            let gnome = Ok::<bool, String>(false);
            if !matches!(gnome, Ok(false)) {
                #[cfg(target_os = "linux")]
                let result = match gnome {
                    Ok(true) => {
                        let binding = binding.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::gnome_shortcut::install(
                                &binding,
                                &std::env::current_exe().map_err(|e| e.to_string())?,
                            )
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    }
                    Err(error) => Err(error),
                    Ok(false) => unreachable!(),
                };
                #[cfg(not(target_os = "linux"))]
                let result = Err("GNOME shortcuts are unavailable on this host.".into());
                Some(result)
            } else {
                #[cfg(target_os = "linux")]
                crate::desktop_identity::prepare(&app)?;
                let state = app.state::<PortalState>();
                let mut current = state.0.lock().await;
                if let Some(previous) = current.take() {
                    previous.close().await;
                }
                let handle = app.clone();
                let result = crate::shortcut_portal::register(
                    &app.config().identifier,
                    &binding,
                    move |event| {
                        let app = handle.clone();
                        let _ = handle.run_on_main_thread(move || match event {
                            crate::shortcut_portal::Event::Activated => activated(&app),
                            crate::shortcut_portal::Event::Changed(label) => {
                                portal_changed(&app, Some(label))
                            }
                            crate::shortcut_portal::Event::Closed => portal_changed(&app, None),
                        });
                    },
                )
                .await;
                #[allow(clippy::bind_instead_of_map)]
                // Linux configuration can fail inside this closure.
                let configured = result.and_then(|registration| {
                    #[cfg(target_os = "linux")]
                    let label = crate::hyprland::configure(
                        &app.path().config_dir().map_err(|e| e.to_string())?,
                        &binding,
                        &app.config().identifier,
                    )?
                    .unwrap_or_else(|| registration.label.clone());
                    #[cfg(not(target_os = "linux"))]
                    let label = registration.label.clone();
                    *current = Some(registration);
                    Ok(label)
                });
                Some(configured)
            }
        } else {
            None
        }
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let state = handle.state::<ShortcutState>();
            let mut setup = state.0.lock().map_err(|e| e.to_string())?;
            #[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
            let registration = match portal_result {
                Some(result) => result,
                None => install(&handle, &binding).map(|()| binding.label()),
            };
            #[cfg(not(any(target_os = "linux", all(test, target_os = "macos"))))]
            let registration = install(&handle, &binding).map(|()| binding.label());
            setup.status = Status {
                label: registration
                    .as_ref()
                    .ok()
                    .filter(|label| !label.is_empty())
                    .cloned()
                    .unwrap_or_else(|| {
                        if setup.status.portal {
                            "Desktop shortcut".into()
                        } else {
                            binding.label()
                        }
                    }),
                binding: binding.clone(),
                platform: std::env::consts::OS,
                square_corners: cfg!(target_os = "linux")
                    && std::path::Path::new("/usr/share/omarchy").is_dir(),
                portal: setup.status.portal,
                registered: registration.is_ok(),
                error: registration.err(),
                phase: Phase::Idle,
            };
            setup.started = None;
            if setup.status.registered {
                let saved = setup.save();
                if let Err(error) = saved {
                    setup.status.error = Some(format!(
                        "Shortcut works for this session but could not be saved: {error}"
                    ));
                }
            }
            let status = setup.status.clone();
            let _ = handle.emit("shortcut-status", &status);
            Ok(status)
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn shortcut_begin_test(
    app: AppHandle,
    state: State<'_, ShortcutState>,
) -> Result<Status, String> {
    let mut setup = state.0.lock().map_err(|e| e.to_string())?;
    setup.begin()?;
    if let Some(window) = app.get_webview_window("launcher") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(setup.status.clone())
}
#[tauri::command]
pub fn shortcut_confirm(state: State<'_, ShortcutState>) -> Result<Status, String> {
    let mut setup = state.0.lock().map_err(|e| e.to_string())?;
    setup.confirm()?;
    if let Err(error) = setup.save() {
        setup.status.error = Some(format!(
            "Test passed for this session, but the shortcut could not be saved: {error}"
        ));
    }
    Ok(setup.status.clone())
}

pub fn activated(app: &AppHandle) {
    let testing = app
        .try_state::<ShortcutState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .map(|setup| setup.status.phase == Phase::Waiting)
        })
        .unwrap_or(false);
    if testing {
        let outside_zega = !app
            .webview_windows()
            .values()
            .any(|window| window.is_focused().unwrap_or(true));
        let opened = crate::menu::open_search_window(app.clone());
        if let Some(state) = app.try_state::<ShortcutState>() {
            if let Ok(mut setup) = state.0.lock() {
                match opened {
                    Ok(()) => setup.received(outside_zega),
                    Err(error) => {
                        setup.status.error = Some(format!(
                            "Keypress arrived, but search could not open: {error}"
                        ));
                        setup.status.phase = Phase::Idle;
                    }
                }
                let _ = app.emit("shortcut-status", &setup.status);
            }
        }
    } else {
        crate::menu::toggle_search_window(app);
    }
}

#[tauri::command]
pub fn close_shortcut_setup(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("shortcut-setup") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_shortcut_setup(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window("shortcut-setup") {
        Some(window) => window,
        None => {
            WebviewWindowBuilder::new(&app, "shortcut-setup", WebviewUrl::App("shortcut/".into()))
                .title("zega · Search shortcut")
                .inner_size(520.0, 440.0)
                .min_inner_size(480.0, 400.0)
                .resizable(true)
                .visible(false)
                .center()
                .build()
                .map_err(|e| e.to_string())?
        }
    };
    crate::window_placement::prepare(&window).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(registered: bool) -> Setup {
        Setup {
            status: Status {
                binding: Binding::default(),
                label: "Alt+Space".into(),
                platform: "test",
                square_corners: false,
                portal: false,
                registered,
                error: None,
                phase: Phase::Idle,
            },
            started: None,
            path: PathBuf::new(),
        }
    }
    #[test]
    fn registration_and_clicks_cannot_pass_a_keypress_test() {
        let mut setup = setup(true);
        assert!(setup.confirm().is_err());
        setup.begin().unwrap();
        assert!(setup.confirm().is_err());
        setup.received(true);
        assert_eq!(setup.status.phase, Phase::Received);
        setup.confirm().unwrap();
        assert_eq!(setup.status.phase, Phase::Confirmed);
    }
    #[test]
    fn a_keypress_inside_zega_does_not_prove_global_dispatch() {
        let mut setup = setup(true);
        setup.begin().unwrap();
        setup.received(false);
        assert!(setup.confirm().is_err());
    }
    #[test]
    fn unavailable_and_expired_shortcuts_cannot_pass() {
        assert!(setup(false).begin().is_err());
        let mut setup = setup(true);
        setup.begin().unwrap();
        setup.started = Some(Instant::now() - Duration::from_secs(31));
        setup.received(true);
        assert_eq!(setup.status.phase, Phase::Expired);
        assert!(setup.confirm().is_err());
    }
}
