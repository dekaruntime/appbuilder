//! Wayland placement belongs to the compositor. GNOME centers dialog surfaces.
#[cfg(target_os = "linux")]
mod linux {
    use gtk::{gio, prelude::*};
    use std::sync::OnceLock;

    fn gnome_session() -> bool {
        static GNOME: OnceLock<bool> = OnceLock::new();
        *GNOME.get_or_init(|| {
            let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>)
            else {
                return false;
            };
            bus.call_sync(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "NameHasOwner",
                Some(&("org.gnome.Shell",).to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                None::<&gio::Cancellable>,
            )
            .ok()
            .and_then(|value| value.get::<(bool,)>())
            .is_some_and(|value| value.0)
        })
    }

    pub(super) fn prepare(window: &gtk::Window) {
        if !window.display().type_().name().contains("Wayland") || !gnome_session() {
            return;
        }
        window.realize();
        if let Some(surface) = window.window() {
            // GTK's Wayland backend sends this through gtk-shell before mapping.
            // Mutter centers parentless dialog surfaces. Do not make the GTK
            // window modal: that would grab input from zega's other windows.
            surface.set_modal_hint(true);
        }
    }

    #[test]
    #[ignore = "requires a live GNOME Wayland session; inspect the emitted dialog hint with the hardware harness"]
    fn native_dialog_hint_does_not_grab_application_input() {
        gtk::init().unwrap();
        assert!(gnome_session());
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_title("zega placement check");
        window.set_default_size(300, 150);
        prepare(&window);
        assert!(!window.is_modal());
        assert!(window.transient_for().is_none());
        window.show();
        let until = std::time::Instant::now() + std::time::Duration::from_millis(150);
        while std::time::Instant::now() < until {
            while gtk::glib::MainContext::default().pending() {
                gtk::glib::MainContext::default().iteration(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        window.close();
    }
}

pub fn prepare(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let target = window.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        window.run_on_main_thread(move || {
            let result = target
                .gtk_window()
                .map(|native| linux::prepare(native.upcast_ref()));
            let _ = tx.send(result);
        })?;
        rx.recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))??;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}
