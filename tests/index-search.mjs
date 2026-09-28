import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { chromium } from 'playwright';

const base = resolve(`.tmp/browser-index-${process.pid}`);
const home = `${base}/home`;
const fixture = spawnSync('python3', ['scripts/generate-test-home.py', '--root', home], { encoding: 'utf8' });
assert.equal(fixture.status, 0, fixture.stderr);
const probe = spawn(resolve('.target/debug/examples/index_probe'), [home, `${base}/graph`], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = [];
let ready;
const readiness = new Promise(resolve => { ready = resolve; });
createInterface({ input: probe.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.ready) ready(message);
  else { const next = waiting.shift(); if (message.error) next.reject(new Error(message.error)); else next.resolve(message.value); }
});
probe.on('exit', code => { for (const next of waiting.splice(0)) next.reject(new Error(`probe exited ${code}`)); });
const query = (command, args) => new Promise((resolve, reject) => {
  waiting.push({ resolve, reject }); probe.stdin.write(`${JSON.stringify({ command, args })}\n`);
});
const server = createServer(async (request, response) => {
  try {
    const path = resolve('out', `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    assert.ok(path.startsWith(`${resolve('out')}/`) || path === resolve('out'));
    const file = (await stat(path)).isDirectory() ? `${path}/index.html` : path;
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' })[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
let browser;
try {
  const indexed = await readiness;
  assert.equal(indexed.counts.Photo, 50);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const calls = [];
  const errors = [];
  const setup = async path => {
    const page = await browser.newPage({ viewport: path === '/launcher/' ? { width: 680, height: 440 } : { width: 1200, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeBinding('fixtureInvoke', async (_, command, args) => {
      calls.push({ command, args });
      if (command.startsWith('index_')) return query(command, args || {});
      if (command === 'local_user_first_name') return 'Fixture';
      if (command === 'local_settings_panes') return [];
      if (command === 'local_pictures_access_granted') return false;
      if (command === 'shortcut_status') return { platform: 'macos', registered: true, label: '⌥Space', squareCorners: false };
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten' || command === 'hide_search_window' || command === 'show_main_window' || command === 'open_settings_pane') return null;
      if (command === 'native_theme') return null;
      if (command === 'account_status') return { signedIn: false };
      throw new Error(`Unexpected IPC: ${command}`);
    });
    await page.addInitScript(() => {
      window.isTauri = true;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.fixtureInvoke(command, args), transformCallback: () => 1, convertFileSrc: path => path };
    });
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    return page;
  };
  const page = await setup('/');
  const input = page.getByRole('textbox', { name: 'Ask computer anything' });
  await input.pressSequentially('lisbn', { delay: 100 });
  await page.getByRole('heading', { name: 'Photos 30 results' }).waitFor();
  assert.equal(await page.locator('.grp').filter({ has: page.getByRole('heading', { name: 'Photos 30 results' }) }).locator('.photo-result-button').count(), 30);
  for (const prefix of ['l', 'li', 'lis', 'lisb', 'lisbn']) assert.ok(calls.some(c => c.command === 'index_search' && c.args.query === prefix), `keystroke ${prefix} queried ZQL`);
  await input.fill('videos last summer');
  await page.getByRole('heading', { name: 'Files 5 results' }).waitFor();
  await page.getByText('Settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Pause indexing' }).click();
  await page.getByRole('button', { name: 'Resume indexing' }).waitFor();
  assert.equal((await query('index_status', {})).paused, true);
  await page.getByRole('button', { name: 'Resume indexing' }).click();
  await page.getByRole('button', { name: 'Rebuild index' }).click();
  await page.getByRole('button', { name: 'Rebuild index' }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.index-settings button:last-of-type')?.disabled);
  assert.equal((await query('index_status', {})).itemsIndexed, 2056);
  await page.screenshot({ path: '.tmp/index-main.png' });
  const launcher = await setup('/launcher/');
  const floating = launcher.getByRole('textbox', { name: 'Search this Mac' });
  await floating.fill('notes-0123');
  await launcher.getByRole('option').filter({ hasText: 'notes-0123.txt' }).waitFor();
  const before = calls.filter(c => c.command === 'show_main_window').length;
  await floating.press('Enter');
  await launcher.locator('main[aria-hidden=true]').waitFor();
  assert.ok(calls.some(c => c.command === 'index_open_result'));
  assert.equal(calls.filter(c => c.command === 'show_main_window').length, before, 'opening a result must not open main window');
  await launcher.reload();
  await launcher.getByRole('textbox').fill('lisbon photos');
  await launcher.getByRole('heading', { name: 'Photos', exact: true }).waitFor();
  assert.equal(await launcher.getByRole('option').count(), 30);
  await launcher.screenshot({ path: '.tmp/index-launcher.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: real graph per keystroke, typo/place/period queries, pause/resume/rebuild, floating action without main window; no page errors');
} finally {
  if (browser) await browser.close();
  server.close();
  probe.stdin.end();
  if (probe.exitCode === null) await once(probe, 'exit');
}
