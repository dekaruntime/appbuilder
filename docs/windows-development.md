# Windows development

Use Node 24 or newer, the Rust MSVC version pinned in `rust-toolchain.toml`, Visual Studio's Desktop
development with C++ tools, and WebView2. See the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

From the repository root in PowerShell, keep build output and temporary files
inside the checkout:

```powershell
New-Item -ItemType Directory -Force .tmp, .target | Out-Null
$env:CARGO_TARGET_DIR = "$PWD\.target"
$env:TMP = "$PWD\.tmp"
$env:TEMP = "$PWD\.tmp"
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.tmp\playwright"
npm.cmd ci
npm.cmd run build:desktop
npm.cmd run check
npm.cmd run test:desktop
npx.cmd playwright install chromium
npm.cmd run test:desktop:windows
npm.cmd run test:desktop:console
npm.cmd run test:desktop:setup
cargo check --locked --workspace --all-targets --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --workspace --all-targets --all-features --manifest-path src-tauri/Cargo.toml
cargo test --locked --workspace --manifest-path src-tauri/Cargo.toml
```

Check `$LASTEXITCODE` after each command. Run one heavy build at a time. The
Windows browser suite runs the static export headlessly; it tests actual
keyboard handlers and IPC dispatch against fixtures, not native hotkey delivery.

For local Rust caching, install [sccache](https://github.com/mozilla/sccache) and
set `RUSTC_WRAPPER` to its executable, `SCCACHE_DIR` to a clone-local cache, and
`CARGO_INCREMENTAL=0`. Keep machine-specific executable paths in untracked
Cargo configuration. `sccache --show-stats` reports actual cache hits; the first
compilation is a miss and final linking is not cached.

The index tests require Python 3. Set `PYTHON` to its executable if it is not
on PATH (avoid the Windows Store placeholder). Then run:

```powershell
python scripts/generate-test-home.py
cargo build --locked --manifest-path src-tauri/Cargo.toml -p computer-index --example index_probe
npm.cmd run test:desktop:index
```

The index browser harness uses the generated fixture and real Rust graph, never
the user's files. The macOS network-interposition proof does not run on Windows;
do not report zero Windows network attempts from that macOS result.

Run the native development app with shortcut setup visible:

```powershell
npm.cmd run tauri -- dev --no-watch -- -- --shortcut-setup
```

Build the executable and per-user NSIS installer:

```powershell
npm.cmd run tauri -- build
```

`src-tauri/tauri.windows.conf.json` enables this packaging only on Windows.
Linux and macOS retain the shared configuration. The Windows ICO is derived
from the existing `src-tauri/icons/icon.png`, using `tauri icon`; retain the PNG
and other platforms' assets when regenerating it.

Windows application search uses the Shell AppsFolder catalogue for installed
desktop apps and Windows/Store apps. Display names are indexed; internal package
IDs are not search terms. The Shell supplies icons on demand, cached in memory.
App discovery runs at startup and when rebuilding the index. Program Files is
not recursively scanned for executables. Existing results from removed app roots
are pruned, without deleting any files or disconnected-drive metadata.

The native shortcut acceptance procedure is in
[shortcuts/README.md](shortcuts/README.md). Test development and built apps
separately. A browser test or successful compilation cannot establish native
focus, shortcut delivery, tray behavior, installer behavior, or suspend/resume.
