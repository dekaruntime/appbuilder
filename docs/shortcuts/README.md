# Search shortcut setup

Default: **Option+Space on macOS; Alt+Space on Windows and Linux**. It is a
starting point, not a promise that every desktop leaves those keys free.

Open **Search shortcut…** in zega's tray menu, or click the shortcut badge in
search. The setup is bundled, works offline, and does not send computer data
anywhere. It opens on first launch and when registration fails. `--autostart`
keeps the main window and setup hidden at login.

1. Choose a combination and **Save & check availability**.
2. **Start keypress test**, focus a different application, and press the keys.
3. Without clicking, type a few letters. Return to setup and confirm that **only
   zega search** appeared and received the typing.

Registration never marks a test successful. Native delivery must arrive within
30 seconds, from outside a zega window, and the search window must open. A click
cannot pass this test. Changing the combination or restarting resets the test.
The chosen combination persists locally; registration is checked each launch.
No system keybindings are changed automatically.

Click-to-open remains available if registration, desktop permission, or testing
fails. A second launch routes to the existing process instead of registering a
second competing shortcut.

## macOS

The app checks enabled macOS symbolic shortcuts and registers its hotkey
exclusively. macOS and shared registrations from other applications can still
behave differently; there is no complete public list of every app's interception.
The outside-app test is required even after registration succeeds.

Choose another combination, or open **Keyboard Settings** from setup. This button
uses the Keyboard pane identifier discovered from the installed system bundles.
In **Keyboard Shortcuts**, change the conflicting system binding, then retry.
For conflicts with Raycast/Alfred or another launcher, change that application's
shortcut. No Accessibility or Input Monitoring permission is required by Carbon
hotkey registration.

## Windows

Alt+Space may overlap with the window menu or PowerToys Run. Direct registration
errors are shown in setup. Try **Control+Alt+Space** if the default is occupied.
Test with another app focused, including an elevated app if you use one. A
successful Windows build on another machine is not a substitute for this check.

## Linux / Omarchy

Native Wayland uses the **XDG GlobalShortcuts portal**. Save requests desktop
approval; cancellation, unavailable portals, and permission expiry are reported.
The portal's returned trigger label takes precedence over the requested default.
X11 uses direct registration. Neither path is declared working without the test.

Hyprland's portal can expose an action without assigning a key. While zega runs:

1. Use `hyprctl globalshortcuts` to find its `search` action and exact application
   identifier. Do not assume the identifier is identical in dev and packaged apps.
2. Check existing bindings using Omarchy's keybinding UI before assigning Alt+Space.
3. Bind that action with Hyprland's `global` dispatcher in the user configuration.
   Use the syntax for the installed version: newer versions use Lua; older ones
   use `bind = ...`. Avoid changing Omarchy's shipped defaults.
4. Run zega's outside-app test against both a native Wayland app and an XWayland
   app. Confirm no second action runs. Repeat after a desktop login.

The portal adapter and its application wiring compile in the Mac test target as
an API check. That does
**not** establish Linux runtime support. A real Omarchy desktop test is required
before calling that platform verified.

## Hardware acceptance checklist

Run against both `tauri dev` and the packaged app:

- Fresh setup: visible explanation, default, click fallback; main window hidden.
- Free combination: save, outside-app keypress, focused search, explicit confirm.
- Occupied combination: actionable error; no crash or invisible failure.
- No keypress / denied portal: never show success; retry and click fallback work.
- Customize, restart: chosen binding restored and label correct; test resets.
- Launch twice: one agent; no self-conflict; existing search opens.
- Close main, open a file from search: file's default app opens, main stays hidden.
- Login / suspend / resume: tray still available; recheck physical shortcut.
- Keyboard layout changes and multiple monitors: verify keys and panel focus.

References: [Tauri global shortcuts](https://v2.tauri.app/plugin/global-shortcut/),
[XDG GlobalShortcuts](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html),
[Hyprland global shortcuts](https://wiki.hypr.land/Configuring/Basics/Binds/#dbus-global-shortcuts),
[PowerToys Run](https://learn.microsoft.com/en-us/windows/powertoys/run).

-codex
