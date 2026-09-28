//! Windows Settings targets. Only fixed, documented URIs are indexed.
//! https://learn.microsoft.com/windows/apps/develop/launch/launch-settings
use super::SettingsPane;

pub(super) fn discover() -> Vec<SettingsPane> {
    discover_with_wifi(has_wifi_adapter())
}

fn discover_with_wifi(wifi: bool) -> Vec<SettingsPane> {
    let mut targets = vec![
        ("Dark mode", "◐", "ms-settings:colors"),
        ("Keyboard", "⌨", "ms-settings:easeofaccess-keyboard"),
        ("Sound", "🔈", "ms-settings:sound"),
        ("Displays", "▭", "ms-settings:display"),
        // The network overview also works on computers without a Wi-Fi adapter.
        ("Network", "⌁", "ms-settings:network-status"),
        ("Bluetooth", "ᛒ", "ms-settings:bluetooth"),
    ];
    if wifi {
        targets.push(("Wi-Fi", "⌁", "ms-settings:network-wifi"));
    }
    targets
        .into_iter()
        .map(|(label, icon, uri)| SettingsPane {
            label,
            icon,
            bundle_id: uri.to_owned(),
        })
        .collect()
}

fn has_wifi_adapter() -> bool {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::WiFi::{
        WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle,
    };
    // The Wi-Fi Settings URI is only available with an adapter. Enumerating
    // interfaces does not scan networks or request location information.
    unsafe {
        let mut version = 0;
        let mut handle = ptr::null_mut();
        if WlanOpenHandle(2, ptr::null(), &mut version, &mut handle) != 0 {
            return false;
        }
        let mut interfaces = ptr::null_mut();
        let success = WlanEnumInterfaces(handle, ptr::null(), &mut interfaces) == 0;
        let available = success && !interfaces.is_null() && (*interfaces).dwNumberOfItems > 0;
        if !interfaces.is_null() {
            WlanFreeMemory(interfaces.cast());
        }
        WlanCloseHandle(handle, ptr::null());
        available
    }
}

pub(super) fn open(pane: &SettingsPane) -> Result<(), String> {
    tauri_plugin_opener::open_url(&pane.bundle_id, None::<&str>)
        .map_err(|error| format!("Windows Settings could not open the selected page: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wifi_is_only_exposed_when_supported() {
        assert!(!discover_with_wifi(false)
            .iter()
            .any(|pane| pane.bundle_id == "ms-settings:network-wifi"));
        assert!(discover_with_wifi(true)
            .iter()
            .any(|pane| pane.bundle_id == "ms-settings:network-wifi"));
        assert!(discover_with_wifi(false)
            .iter()
            .any(|pane| pane.bundle_id == "ms-settings:bluetooth"));
    }
}
