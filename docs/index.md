# Computer index and graph search

Implements the Index and Search bar sections of [desktop #10](https://github.com/zegadb/desktop/issues/10), following [APS 31](https://github.com/zegadb/aps/blob/main/aps/0031-desktop.md). The existing desktop/launcher layout is retained; the new Index controls use its existing small settings buttons. Period definitions follow [APS 24](https://github.com/zegadb/aps/blob/main/aps/0024-time.md).

## Storage and privacy

`src-tauri/computer-index` is a separate Rust workspace crate. It embeds `zega` at **2082501631b534c379df73150dd26eebcc80d529**, with `default-features = false` (no engine HTTP transport). The pinned engine has no filesystem crawler API; the desktop-owned Rust crawler is the common baseline on all platforms. Spotlight is not required or invoked by graph indexing/search.

Tauri opens `<app data>/computer`. Files remain in place. The graph stores metadata only. The index directory is mode 0700 on Unix. There is no API accepting arbitrary ZQL, file imports, URLs, or user-selected output paths. Search text is quoted as a ZQL string; batched writes supply JSON strings directly to the engine, without reading a temporary import file. Account/auth networking is outside this crate and is not used by it.

The crawler visits home (including Documents, Pictures, Movies/Videos, Downloads, Desktop) and installed-app locations. App bundles are leaves. It excludes dot directories, `.git`, `node_modules`, caches, Library/AppData/system directories, symlinks and nonregular files. Explicit installed-app roots are allowed, including Linux `.local/share/applications` and Windows Start Menu entries. Network filesystems are excluded. Unreadable paths retain previously indexed metadata and contribute to the status row's skipped count.

The worker runs at background QoS on macOS / minimum thread priority elsewhere, yields every 32 entries, coalesces watcher events, and uses `notify` (FSEvents/inotify/ReadDirectoryChangesW). A two-second reconciliation fallback also catches missed events/remounts. Unchanged files reuse metadata after checking native identity, size and nanosecond mtime, so each pass does not reread photo/video containers. The initial scan and startup reconcile run without opening a window.

## Schema and identity

[`schema.zql`](../src-tauri/computer-index/schema.zql) is executed by the engine. Each filesystem entry has one specialized node type: File, Folder, App, Photo or Video. **Photo/Video/App are not duplicated as File nodes.** Every type has path, volume, file ID, size, nanosecond mtime and fingerprint. Other nodes are Place, Day, Camera, Volume, APS-style Period, discovered Action, and one internal Scan status node.

The schema aliases IN_FOLDER, ON_VOLUME, TAKEN_ON, TAKEN_AT and SHOT_WITH as `inFolder`, `onVolume`, `takenOn`, `takenAt` and `shotWith`. These implement the plan's in-folder/on-volume/taken-on/taken-at/shot-with relationships.

Identity is volume + native file ID + SHA-256(size + up to 4 KiB head + up to 4 KiB tail). Directories use a directory marker. A rename/move **within a volume** updates the existing engine node and folder relationship. Moving across filesystems creates a new native identity. macOS uses volume UUIDs where available; Linux uses `/dev/disk/by-uuid` when available (native device ID fallback), and Windows uses volume serial numbers. A quick fingerprint deliberately is not a full-content hash. The stored identity also includes file ID, so different files with identical sampled bytes are not deduplicated.

A mount probe distinguishes a missing directory on a present volume from an absent volume. Disconnected entries remain searchable with `offline: true`; opening them returns an error. Confirmed deletions remove nodes and incident edges. Rebuild retains offline metadata. Completed scan time survives restart. Startup reconciliation repairs partially completed writes as well as changes made while the app was closed.

## Metadata and query semantics

- `kamadak-exif` reads JPEG, PNG, HEIF/HEIC and TIFF-based RAW EXIF; `imagesize` supplies dimensions when available. Captured time, GPS, camera and dimensions become graph fields/relationships. Unsupported or malformed metadata leaves a basic file node of the media type; it does not invent values. Metadata buffers are capped at 16 MiB, so unusually large/misplaced metadata can be unavailable.
- The Rust ISO BMFF reader seeks past media payloads and reads bounded MP4/MOV `moov` metadata: version 0/1 creation times/durations, track dimensions, QuickTime `©xyz` and ISO6709 `mdta` values. No ffmpeg, decoding or media copying.
- The bundled **31,760** city entries derive from GeoNames cities15000, excluding neighbourhood (`PPLX`) entries. Nearest-city resolution stops at 100 km. It is an approximation, not an address. [CC BY 4.0 attribution](../src-tauri/computer-index/data/ATTRIBUTION.md) is bundled and surfaced in Settings > Index.
- Each edit in either search surface invokes a Rust ZQL query; stale IPC responses are discarded. Results are grouped as actions, apps, files (including videos), photos, capped at 30 per queried type. A small spelling vocabulary from committed graph records proposes typo candidates, which are always checked again through ZQL.
- `lisbon photos` and `lisbn` walk `takenAt` to Place; `videos last summer` walks `takenOn` and `inPeriod`. Seasons currently mean northern-hemisphere meteorological seasons. “Last summer” is the most recently completed June–August period. Capture timestamps without an EXIF offset retain their camera-local date.
- Floating Enter acts directly through the existing opener/settings APIs; only the explicit Command+Enter action opens the main window. Existing photo-preview access remains limited to the granted Pictures folder; metadata results elsewhere remain usable without extending the asset-protocol scope.

## Reproduce the proof, headlessly

From the clone, set `TMPDIR="$PWD/.tmp"` and `CARGO_TARGET_DIR="$PWD/.target"`; create `.tmp` with mode 0700 first. Do not run more than two Rust builds on the machine.

```sh
python3 scripts/generate-test-home.py --root "$PWD/.tmp/test-home"
cargo test --locked --manifest-path src-tauri/Cargo.toml -p computer-index -- --nocapture
python3 scripts/revert-prove-index.py
cargo build --locked --manifest-path src-tauri/Cargo.toml -p computer-index --example index_probe
python3 scripts/prove-index-network.py
npm run build
npm run check
npm run test:desktop
npm run test:desktop:index
npm run test:desktop:console
```

The generator writes 2,000 ordinary files, 50 valid PNGs whose TIFF/EXIF/GPS bytes it constructs itself, five synthetic MP4 containers with real metadata atoms (no encoded video samples), one app entry, 17 visible folders and excluded-directory traps. Generated files are ignored, never committed. Graph tests assert counts, Place/Day/period resolution, stable engine IDs, offline/deletion/reconnect handling, new-file visibility under five seconds, p95 under 50 ms, safe escaping, and disk reopen. Metadata tests independently assert the actual extracted values and malformed-atom bounds.

The network test interposes internet socket creation and DNS lookup in the standalone index process and refuses/counts attempts. It asserts zero attempts during the full scan and semantic searches. A positive control must record a blocked attempt before the zero-attempt result is accepted. It reports `/usr/bin/time -l` peak RSS. This is a **macOS process-network proof**, not a claim about account networking or kernel/third-party processes.

The browser test is headless Chromium serving the static export, with Tauri IPC transported over stdin/stdout to the real index crate on the generated home. Only window/platform/auth operations are test adapters; graph results are actual ZQL results. No desktop application or external file opener is launched. The harness fixes the query date to 2026-09-28 for reproducibility.

The revert script temporarily makes identity path-dependent, then disables offline marking; each targeted regression test must fail with exit 101. It restores source in `finally` and reruns the fixture suite. Run it alone in this checkout.

Native Windows/Linux runs, installed-app activation, permission prompts and physical drive unmounts remain for Sami's platform round. The injectable mount provider tests state transitions without unmounting a real disk. Numbers and complete gate exit codes are recorded in the PR.
