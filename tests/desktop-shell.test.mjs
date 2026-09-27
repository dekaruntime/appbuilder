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

test('MapLibre uses the same-origin module worker and its adjacent shared chunk', () => {
  const config = readFileSync('src/lib/maplibre-worker.ts', 'utf8');
  const worker = readFileSync('out/globe/maplibre-gl-worker.mjs', 'utf8');
  const shared = readFileSync('out/globe/maplibre-gl-shared.mjs', 'utf8');
  assert.match(config, /setWorkerUrl\('\/globe\/maplibre-gl-worker\.mjs'\)/);
  assert.match(worker, /maplibre-gl-shared\.mjs/);
  assert.ok(shared.length > 100_000, 'the bundled shared worker module was copied');
});
