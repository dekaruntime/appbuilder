//! Native Wayland shortcuts go through the desktop's consent portal, never XWayland grabs.
use crate::shortcut_config::Binding;
use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut},
    Session,
};
use futures_util::StreamExt;
use std::{sync::Arc, time::Duration};

pub enum Event {
    Activated,
    Changed(String),
    Closed,
}
pub struct Registration {
    session: Option<Arc<Session<GlobalShortcuts>>>,
    listener: Option<tauri::async_runtime::JoinHandle<()>>,
    pub label: String,
}
impl Registration {
    pub async fn close(mut self) {
        if let Some(listener) = self.listener.take() {
            listener.abort();
        }
        if let Some(session) = self.session.take() {
            let _ = session.close().await;
        }
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(listener) = self.listener.take() {
            listener.abort();
        }
        if let Some(session) = self.session.take() {
            tauri::async_runtime::spawn(async move {
                let _ = session.close().await;
            });
        }
    }
}

pub fn preferred_trigger(binding: &Binding) -> String {
    let key = binding.key.strip_prefix("Key").unwrap_or(&binding.key);
    let key = if key == "Space" {
        "space".into()
    } else {
        if binding.key.starts_with("Key") {
            key.to_ascii_lowercase()
        } else {
            key.to_owned()
        }
    };
    let mut parts = Vec::new();
    if binding.control {
        parts.push("CTRL");
    }
    if binding.alt {
        parts.push("ALT");
    }
    if binding.shift {
        parts.push("SHIFT");
    }
    if binding.super_key {
        parts.push("LOGO");
    }
    parts.push(&key);
    parts.join("+")
}

pub async fn register(
    app_id: &str,
    binding: &Binding,
    callback: impl Fn(Event) + Send + 'static,
) -> Result<Registration, String> {
    // A fresh peer allows replacement/retry after a portal restart. The registry
    // accepts identity only before the first portal request on that connection.
    let connection = ashpd::zbus::Connection::session()
        .await
        .map_err(|e| e.to_string())?;
    ashpd::register_host_app_with_connection(
        connection.clone(),
        app_id.parse().map_err(|e: ashpd::Error| e.to_string())?,
    )
    .await
    .map_err(|e| format!("Could not identify zega to the desktop: {e}"))?;
    let portal = GlobalShortcuts::with_connection(connection).await.map_err(|e| format!("Your desktop's global-shortcut portal is unavailable: {e}. Click-to-open search still works."))?;
    let session = Arc::new(
        portal
            .create_session(Default::default())
            .await
            .map_err(|e| e.to_string())?,
    );
    // Own cleanup before any later fallible operation, including permission denial.
    let mut registration = Registration {
        session: Some(session.clone()),
        listener: None,
        label: String::new(),
    };
    let trigger = preferred_trigger(binding);
    let requested =
        [NewShortcut::new("search", "Open zega search").preferred_trigger(trigger.as_str())];
    let response = tokio::time::timeout(
        Duration::from_secs(60),
        portal.bind_shortcuts(&session, &requested, None, Default::default()),
    )
    .await;
    let response = match response {
        Ok(Ok(request)) => request
            .response()
            .map_err(|e| format!("Desktop shortcut permission was not granted: {e}")),
        Ok(Err(error)) => Err(format!("Desktop shortcut setup failed: {error}")),
        Err(_) => Err(
            "Desktop shortcut permission timed out. Retry and respond to the desktop prompt."
                .into(),
        ),
    };
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let label = match response
        .shortcuts()
        .iter()
        .find(|shortcut| shortcut.id() == "search")
    {
        Some(shortcut) => shortcut.trigger_description().to_owned(),
        None => {
            return Err("The desktop did not return zega's shortcut. Retry desktop setup.".into());
        }
    };
    let mut activated = portal
        .receive_activated()
        .await
        .map_err(|e| e.to_string())?;
    let mut changed = portal
        .receive_shortcuts_changed()
        .await
        .map_err(|e| e.to_string())?;
    let path = serde_json::to_value(&*session)
        .map_err(|e| e.to_string())?
        .as_str()
        .ok_or("Missing portal session path")?
        .to_owned();
    let watched = session.clone();
    let listener = tauri::async_runtime::spawn(async move {
        let Ok(mut closed) = watched.receive_closed().await else {
            callback(Event::Closed);
            return;
        };
        loop {
            tokio::select! {
                event = activated.next() => match event {
                    Some(event) if event.session_handle().as_str() == path && event.shortcut_id() == "search" => callback(Event::Activated),
                    Some(_) => {}, None => break,
                },
                event = changed.next() => match event {
                    Some(event) if event.session_handle().as_str() == path => {
                        if let Some(shortcut) = event.shortcuts().iter().find(|shortcut| shortcut.id() == "search") { callback(Event::Changed(shortcut.trigger_description().into())); }
                        else { break; }
                    },
                    Some(_) => {}, None => break,
                },
                _ = closed.next() => break,
            }
        }
        callback(Event::Closed);
    });
    registration.listener = Some(listener);
    registration.label = label;
    Ok(registration)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portal_accelerators_use_the_xdg_specification() {
        assert_eq!(
            preferred_trigger(&Binding::for_platform("macos")),
            "ALT+space"
        );
        assert_eq!(preferred_trigger(&Binding::for_platform("linux")), "LOGO+z");
        let binding = Binding {
            key: "KeyK".into(),
            control: true,
            ..Binding::for_platform("macos")
        };
        assert_eq!(preferred_trigger(&binding), "CTRL+ALT+k");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires live Hyprland; installs/removes a test identity and dispatches its action"]
    async fn real_portal_accepts_identity_and_repeated_registration() {
        use std::io::Write;
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let id = format!(
            "{}.PortalTest{}",
            config["identifier"].as_str().unwrap(),
            std::process::id()
        );
        let directory = gdk::glib::user_data_dir().join("applications");
        std::fs::create_dir_all(&directory).unwrap();
        struct Entry(std::path::PathBuf);
        impl Drop for Entry {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let path = directory.join(format!("{id}.desktop"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let _entry = Entry(path);
        file.write_all(
            crate::desktop_identity::desktop_entry(&std::env::current_exe().unwrap())
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        drop(file);
        for attempt in 0..2 {
            let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
            let registration = register(&id, &Binding::default(), move |event| {
                if matches!(event, Event::Activated) {
                    let _ = events.send(());
                }
            })
            .await
            .expect("the desktop must accept zega's identified search action");
            let reply = std::process::Command::new("hyprctl")
                .args([
                    "-i",
                    "0",
                    "eval",
                    &format!("hl.dispatch(hl.dsp.global(\"{id}:search\"))"),
                ])
                .output()
                .unwrap();
            assert!(reply.status.success());
            assert_eq!(String::from_utf8_lossy(&reply.stdout).trim(), "ok");
            let event = tokio::time::timeout(Duration::from_secs(3), received.recv()).await;
            assert!(
                matches!(event, Ok(Some(()))),
                "registration {attempt} must deliver the real compositor action: {event:?}"
            );
            registration.close().await;
        }
    }
}
