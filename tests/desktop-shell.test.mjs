import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

test('static export opens on the computer graph shell', () => {
  const html = readFileSync('out/index.html', 'utf8');
  assert.match(html, /aria-label="Graphs"/);
  assert.match(html, /aria-label="computer"/);
  assert.match(html, /zega <span class="v">computer<\/span>/);
  assert.match(html, /Ask <span class="v">computer<\/span> anything/);
  assert.match(html, /aria-label="Ask computer anything"/);
  assert.match(html, /src="\/desktop-auth\.js"/);
  assert.match(readFileSync('src/app/page.tsx', 'utf8'), /hour < 12 \? 'Good morning' : hour < 18 \? 'Good afternoon' : 'Good evening'/);
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

test('product source contains no sample data from the design mock', () => {
  const sourceFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : /\.(tsx?|jsx?)$/.test(entry.name) ? [path] : [];
  });
  const sampleData = ['Lisbon itinerary', 'Bow River', 'Good afternoon, Sami', 'zega pitch — Sept.key'];
  for (const file of sourceFiles('src')) {
    const source = readFileSync(file, 'utf8');
    for (const sample of sampleData) assert.ok(!source.includes(sample), `${sample} must not appear in ${file}`);
  }
});

test('landing shelves use only local results, permission state, and a dynamic greeting', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  const local = readFileSync('src-tauri/src/local.rs', 'utf8');
  const native = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  assert.match(page, /useGraphSearch/);
  assert.match(page, /local_user_first_name/);
  assert.match(page, /Good morning/);
  assert.match(page, /Good afternoon/);
  assert.match(page, /Good evening/);
  assert.match(page, /No recent files yet/);
  assert.match(page, /Loading recent files/);
  assert.match(page, /index_search/);
  assert.match(page, /Choose Pictures folder/);
  assert.match(page, /convertFileSrc\(photo\.path\)/);
  assert.doesNotMatch(page, /aria-label="Speak"|Good afternoon, Sami/);
  assert.match(local, /NSFullUserName/);
  assert.match(local, /public\.image/);
  assert.match(local, /request_pictures_access/);
  assert.match(local, /set_directory\(&pictures\)/);
  assert.match(local, /canonicalize\(\)/);
  assert.match(native, /local_user_first_name/);
  assert.match(native, /tauri_plugin_dialog::init/);
  assert.equal(config.app.security.assetProtocol.enable, true);
  assert.deepEqual(config.app.security.assetProtocol.scope, ['$PICTURE/**']);
});

test('floating search is a local Tauri window with keyboard result actions', () => {
  const html = readFileSync('out/launcher/index.html', 'utf8');
  const page = readFileSync('src/app/launcher/page.tsx', 'utf8');
  const native = readFileSync('src-tauri/src/menu.rs', 'utf8');
  const app = readFileSync('src-tauri/src/lib.rs', 'utf8');
  assert.match(html, /aria-label="zega floating search"/);
  assert.match(html, /aria-label="Local results"/);
  assert.match(page, /useGraphSearch\(query\)/);
  assert.match(page, /resultGroups/);
  assert.match(page, /ArrowDown/);
  assert.match(page, /ArrowUp/);
  assert.match(page, /event\.key === 'Enter'/);
  assert.match(page, /event\.key === 'Escape'/);
  assert.match(native, /TrayIconBuilder::new\(\)/);
  assert.match(native, /always_on_top\(true\)/);
  assert.match(native, /WebviewUrl::App\("launcher\/"\.into\(\)\)/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /trailingSlash: true/);
  assert.match(readFileSync('src-tauri/src/shortcut_setup.rs', 'utf8'), /on_shortcut\(binding.accelerator\(\).as_str\(\)/);
  assert.match(native, /\.transparent\(true\)/);
  assert.equal(JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.macOSPrivateApi, true);
  assert.match(readFileSync('src/app/globals.css', 'utf8'), /\.float-root[^\n]*background: transparent/);
});

test('the main window capability permits its draggable title bar', () => {
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  assert.ok(capability.windows.includes('main'));
  assert.ok(capability.permissions.includes('core:window:allow-start-dragging'));
});

test('the menu agent starts without the main window and exposes explicit zega access', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const main = config.app.windows.find(window => window.label === 'main');
  const menu = readFileSync('src-tauri/src/menu.rs', 'utf8');
  const launcher = readFileSync('src/app/launcher/page.tsx', 'utf8');
  const app = readFileSync('src-tauri/src/lib.rs', 'utf8');
  assert.equal(main.visible, false);
  assert.match(menu, /ActivationPolicy::Accessory/);
  assert.match(menu, /ActivationPolicy::Regular/);
  assert.match(menu, /"main"\s*=>\s*show_main_window/);
  assert.match(app, /main_window_closed\(window\.app_handle\(\)\)/);
  assert.match(launcher, /event\.metaKey && event\.key === 'Enter'/);
  assert.match(launcher, /openGraphResult\(result\)/);
  const graph = readFileSync('src/lib/index-search.ts', 'utf8');
  assert.match(graph, /invoke\('index_open_result'/);
  assert.match(graph, /invoke\('open_settings_pane'/);
});

test('MapLibre uses the same-origin module worker and its adjacent shared chunk', () => {
  const config = readFileSync('src/lib/maplibre-worker.ts', 'utf8');
  const worker = readFileSync('out/globe/maplibre-gl-worker.mjs', 'utf8');
  const shared = readFileSync('out/globe/maplibre-gl-shared.mjs', 'utf8');
  assert.match(config, /setWorkerUrl\('\/globe\/maplibre-gl-worker\.mjs'\)/);
  assert.match(worker, /maplibre-gl-shared\.mjs/);
  assert.ok(shared.length > 100_000, 'the bundled shared worker module was copied');
});
