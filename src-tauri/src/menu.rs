use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    set_accessory_policy(app);
    let search = MenuItem::with_id(app, "search", "Search", true, None::<&str>)?;
    let main = MenuItem::with_id(app, "main", "Open zega", true, None::<&str>)?;
    let setup = MenuItem::with_id(
        app,
        "shortcut-setup",
        "Search shortcut…",
        true,
        None::<&str>,
    )?;
    let divider = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let menu = Menu::with_items(app, &[&search, &main, &setup, &divider, &quit])?;

    TrayIconBuilder::new()
        .icon(tray_image())
        .icon_as_template(true)
        .tooltip("zega · computer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "search" => toggle_search_window(app),
            "main" => show_main_window(app.clone()),
            "shortcut-setup" => {
                let _ = crate::shortcut_setup::show_shortcut_setup(app.clone());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                toggle_search_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn toggle_search_window(app: &AppHandle) {
    let result = (|| -> tauri::Result<()> {
        let window = search_window(app)?;
        if window.is_visible()? {
            window.hide()?;
        } else {
            window.show()?;
            window.set_focus()?;
            activate_search_window(app);
            app.emit("launcher-opened", ())?;
        }
        Ok(())
    })();
    let _ = result;
}

#[tauri::command]
pub fn open_search_window(app: AppHandle) -> Result<(), String> {
    let window = search_window(&app).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    activate_search_window(&app);
    app.emit("launcher-opened", ()).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn activate_search_window(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        if let Some(main_thread) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(main_thread).activate();
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn activate_search_window(_: &AppHandle) {}

fn search_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("launcher") {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        "launcher",
        // With `trailingSlash`, `/launcher/` works against Next's dev server
        // and resolves to `launcher/index.html` in the static bundle.
        WebviewUrl::App("launcher/".into()),
    )
    .title("zega Search")
    .inner_size(680.0, 440.0)
    // Wayland compositors need matching limits to recognize a fixed-size panel.
    .min_inner_size(680.0, 440.0)
    .max_inner_size(680.0, 440.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    // The native shadow includes transparent webview pixels on macOS.
    .shadow(false)
    .effects(
        tauri::window::EffectsBuilder::new()
            .effect(tauri::utils::WindowEffect::Popover)
            .state(tauri::utils::WindowEffectState::Active)
            .radius(16.0)
            .build(),
    )
    .visible(false)
    .center()
    .build()?;
    crate::window_placement::prepare(&window)?;
    Ok(window)
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    set_regular_policy(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn main_window_closed(app: &AppHandle) {
    set_accessory_policy(app);
}

#[cfg(target_os = "macos")]
fn set_accessory_policy(app: &AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

#[cfg(not(target_os = "macos"))]
fn set_accessory_policy(_: &AppHandle) {}

#[cfg(target_os = "macos")]
fn set_regular_policy(app: &AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
}

#[cfg(not(target_os = "macos"))]
fn set_regular_policy(_: &AppHandle) {}

#[tauri::command]
pub fn hide_search_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("launcher")
        .ok_or_else(|| "The floating search window is not open".to_owned())?;
    window.hide().map_err(|error| error.to_string())
}

fn tray_image() -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
    let center = 13.5_f32;
    let radius = 9.5_f32;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            let globe = (distance - radius).abs() <= 1.2
                || (dx.abs() <= 0.8 && dy.abs() <= radius)
                || (dy.abs() <= 0.8 && dx.abs() <= radius);
            if globe {
                set_icon_pixel(&mut rgba, x, y, SIZE);
            }
        }
    }
    for offset in 0..9 {
        set_icon_pixel(&mut rgba, 20 + offset, 20 + offset, SIZE);
        set_icon_pixel(&mut rgba, 21 + offset, 20 + offset, SIZE);
        set_icon_pixel(&mut rgba, 20 + offset, 21 + offset, SIZE);
    }
    // Template glyph pixels are opaque; untouched pixels retain alpha 0 so
    // the macOS menu-bar background shows through the icon.
    Image::new_owned(rgba, SIZE, SIZE)
}

fn set_icon_pixel(rgba: &mut [u8], x: u32, y: u32, width: u32) {
    if x >= width || y >= width {
        return;
    }
    let index = ((y * width + x) * 4) as usize;
    rgba[index..index + 4].copy_from_slice(&[0, 0, 0, 255]);
}

#[cfg(test)]
mod tests {
    use super::tray_image;

    #[test]
    fn menu_bar_image_has_a_transparent_background_and_visible_mark() {
        let image = tray_image();
        let pixels = image.rgba();
        assert_eq!(image.width(), 32);
        assert_eq!(image.height(), 32);
        assert_eq!(pixels[3], 0, "the image corner stays transparent");
        let (pixels, _) = pixels.as_chunks::<4>();
        assert!(pixels.iter().any(|pixel| pixel[3] == 0));
        assert!(pixels.iter().any(|pixel| pixel[3] == 255));
    }
}
