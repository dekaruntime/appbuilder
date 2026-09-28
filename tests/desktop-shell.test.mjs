import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('static export opens on the computer graph shell', () => {
  const html = readFileSync('out/index.html', 'utf8');
  assert.match(html, /aria-label="Graphs"/);
  assert.match(html, /aria-label="computer"/);
  assert.match(html, /zega <span class="v">computer<\/span>/);
  assert.match(html, /Ask <span class="v">computer<\/span> anything/);
  assert.match(html, /aria-label="Ask computer anything"/);
  assert.match(html, /src="\/desktop-auth\.js"/);
  assert.match(html, /Good afternoon, Sami/);
  assert.match(html, /Recent files/);
  assert.match(html, /Recent photos/);
  assert.doesNotMatch(html, /Download link|marketing homepage/i);
});

test('desktop auth uses the loopback account commands', () => {
  const auth = readFileSync('public/desktop-auth.js', 'utf8');
  const native = readFileSync('src-tauri/src/account.rs', 'utf8');
  const loopback = readFileSync('src-tauri/src/loopback.rs', 'utf8');
  assert.match(auth, /invoke\('account_start'\)/);
  assert.match(auth, /invoke\('account_status'\)/);
  assert.match(native, /https:\/\/account\.zega\.earth/);
  assert.match(loopback, /challenge/);
  assert.match(native, /dev\.zega\.desktop/);
});

test('computer data comes from local Spotlight and machine-discovered settings panes', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  const local = readFileSync('src-tauri/src/local.rs', 'utf8').split('#[cfg(test)]')[0];
  assert.match(page, /invoke<LocalFile\[]>\('local_recent_files'\)/);
  assert.match(page, /invoke<LocalPane\[]>\('local_settings_panes'\)/);
  assert.match(page, /open_settings_pane/);
  assert.match(page, /Preview placeholder/);
  assert.match(local, /kMDItemContentModificationDate >= \$time\.now\(-604800\)/);
  assert.match(local, /\.arg\("-onlyin"\)/);
  assert.match(local, /Value::from_file\(info\)/);
  assert.match(local, /x-apple\.systempreferences:/);
  assert.doesNotMatch(local, /com\.apple\.preference\.(network|sound|displays)/);
});

test('floating search is a local Tauri window with keyboard result actions', () => {
  const html = readFileSync('out/launcher/index.html', 'utf8');
  const page = readFileSync('src/app/launcher/page.tsx', 'utf8');
  const native = readFileSync('src-tauri/src/menu.rs', 'utf8');
  const app = readFileSync('src-tauri/src/lib.rs', 'utf8');
  assert.match(html, /aria-label="zega floating search"/);
  assert.match(html, /aria-label="Local results"/);
  assert.match(page, /invoke<LocalFile\[]>\('local_recent_files'\)/);
  assert.match(page, /invoke<LocalPane\[]>\('local_settings_panes'\)/);
  assert.match(page, /ArrowDown/);
  assert.match(page, /ArrowUp/);
  assert.match(page, /event\.key === 'Enter'/);
  assert.match(page, /event\.key === 'Escape'/);
  assert.match(native, /TrayIconBuilder::new\(\)/);
  assert.match(native, /always_on_top\(true\)/);
  assert.match(native, /WebviewUrl::App\("launcher\/"\.into\(\)\)/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /trailingSlash: true/);
  assert.match(app, /with_shortcuts\(\["alt\+space"\]\)/);
});

test('the main window capability permits its draggable title bar', () => {
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  assert.ok(capability.windows.includes('main'));
  assert.ok(capability.permissions.includes('core:window:allow-start-dragging'));
});

test('MapLibre uses the same-origin module worker and its adjacent shared chunk', () => {
  const config = readFileSync('src/lib/maplibre-worker.ts', 'utf8');
  const worker = readFileSync('out/globe/maplibre-gl-worker.mjs', 'utf8');
  const shared = readFileSync('out/globe/maplibre-gl-shared.mjs', 'utf8');
  assert.match(config, /setWorkerUrl\('\/globe\/maplibre-gl-worker\.mjs'\)/);
  assert.match(worker, /maplibre-gl-shared\.mjs/);
  assert.ok(shared.length > 100_000, 'the bundled shared worker module was copied');
});
