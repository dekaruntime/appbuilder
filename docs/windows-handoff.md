# Native Windows handoff

Sami will resume Codex directly on the Windows 11 Home laptop. **No SSH or
Tailscale setup is required.** Work alone, on that machine, with Sami present
for physical keyboard tests.

## Starting point

- Private repository: `zegadb/desktop`.
- Fetch and check out existing branch `codex/hotkey-5`, PR #6. Search cleanup
  and GNOME placement landed on that branch in `68646d4`; fetch its latest tip.
- PR stack: #2 scaffold → #4 local data → #6 launcher and shortcut setup.
- Omarchy palette work is a separate draft, PR #8 / `codex/omarchy-theme-7`.
- Read applicable local `AGENTS.md` files and `docs/shortcuts/README.md` first.
- Push fixes to the existing owning branch. No new duplicate PR, merge, tag,
  release, AI commit trailer, CI polling, or credential copying.
- Preserve existing changes. One heavy build at a time; logs, temporary files
  and build output stay in the clone. Screenshots are PR comment attachments,
  never committed. Sign PR bodies/comments and reports `-codex`.

## First session

Estimate **1 hour** for first native build and shortcut acceptance; stop and
report at **2 hours**. Report a missing prerequisite promptly.

1. Inventory Windows version/architecture, Git, Node, Rust/MSVC toolchain,
   C++ build tools, WebView2 and sccache. Check current official Tauri Windows
   prerequisites before installing anything. Use existing GitHub access;
   missing credentials → `Needs Sami: GitHub access on Windows`.
2. Use one checkout in the Windows agent workspace. Configure clone-local
   `.tmp` and `.target` paths using PowerShell syntax. Do not copy macOS paths
   or Linux commands from older logs.
3. `npm ci`, `npm run build:desktop`, `npm run check`, `npm run test:desktop`.
   Install the headless browser needed by the existing tests, then run
   `npm run test:desktop:console` and `npm run test:desktop:setup`.
4. Native gates: `cargo check --locked --workspace --all-targets
   --manifest-path src-tauri/Cargo.toml` and `cargo clippy --locked --workspace
   --all-targets --all-features --manifest-path src-tauri/Cargo.toml`.
   Capture logs and each command's actual exit code. Check both dev and built
   Windows application, without publishing a release.
5. Run `npm run tauri -- dev --no-watch -- -- --shortcut-setup` for the native
   development flow. Use `npm run tauri -- build` for the built app; inspect the
   actual output path. Missing signing credentials do not authorize inventing,
   transferring or configuring secrets.

## Acceptance with Sami

Windows default is **Alt+Space**, with **Control+Alt+Space** suggested when
occupied. Do not change Windows or other apps' shortcuts automatically.

- Setup fits without scrolling; error and Help views remain reachable.
- With another app focused, Test shortcut → Alt+Space → immediate typing.
  Only zega should open. Registration alone is not a passed physical test.
- Check native window-menu / PowerToys conflicts if present, customization,
  persistence, timeout and retry. Test elevated applications separately.
- Tray click opens the same floating, centered search. Drag the header.
  Corners stay rounded on Windows; no opaque outer rectangle.
- Search has **17px text**, no top-right shortcut badge, no submit arrow.
  Typing filters; Enter acts; Escape closes with input, row or background focus.
- Main remains hidden for normal search actions. Explicit Open zega opens it;
  closing main keeps the agent alive. Check Windows modifier handling rather
  than assuming the macOS Command+Enter behavior is correct here.
- Launch twice, suspend/resume, and multiple monitors. Keep click fallback
  usable if the shortcut fails. Do not silently accept a focus failure.

## Known limits / other machines

- **Windows native runtime has not been tested yet.** macOS/Linux builds and
  browser fixtures do not establish Windows correctness.
- Local file/settings discovery is still macOS-specific; Linux/Windows data
  parity is not done. Never add sample files to make an empty screen look live.
- Sami confirmed Ubuntu shortcut/setup tests work. A GNOME placement fix is
  now running there; final visual centering confirmation is pending.
- Omarchy Super+Z, floating/square search and Escape fixes are in #6. Theme
  matching is in #8; final native palette acceptance waits for that laptop.
- PR screenshot attachment upload was unavailable on bugsy. Local screenshots
  are evidence files, not uploaded attachments; don't claim otherwise.
- Apple Developer ID / notarization is a later Sami dependency.

-codex
