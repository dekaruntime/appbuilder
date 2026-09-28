use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let search = MenuItem::with_id(app, "search", "Search", true, None::<&str>)?;
    let main = MenuItem::with_id(app, "main", "Open zega", true, None::<&str>)?;
    let divider = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let menu = Menu::with_items(app, &[&search, &main, &divider, &quit])?;

    TrayIconBuilder::new()
        .icon(tray_image())
        .icon_as_template(true)
        .tooltip("zega · computer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "search" => toggle_search_window(app),
            "main" => show_main_window(app),
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
            app.emit("launcher-opened", ())?;
        }
        Ok(())
    })();
    let _ = result;
}

fn search_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("launcher") {
        return Ok(window);
    }
    WebviewWindowBuilder::new(
        app,
        "launcher",
        // With `trailingSlash`, `/launcher/` works against Next's dev server
        // and resolves to `launcher/index.html` in the static bundle.
        WebviewUrl::App("launcher/".into()),
    )
    .title("zega Search")
    .inner_size(720.0, 440.0)
    .min_inner_size(600.0, 340.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .visible(false)
    .center()
    .build()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

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
        assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 0));
        assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 255));
    }
}
