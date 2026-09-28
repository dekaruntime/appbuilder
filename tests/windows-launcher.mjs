import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright';

// Exercise the exported app, including its real keyboard handlers and IPC calls.
const root = resolve('out');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(data);
  } catch { response.writeHead(404).end(); }
});
let browser;
let origin;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

async function launcher({ failFiles = false, platform = 'windows', appResult = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 680, height: 440 } });
  await page.addInitScript(({ failFiles, platform, appResult }) => {
    window.isTauri = true;
    window.commands = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return 1; },
      async invoke(command, args) {
        window.commands.push([command, args]);
        if (command === 'shortcut_status') return { platform, squareCorners: false };
        if (command === 'native_theme') return null;
        if (command === 'index_status') return { itemsIndexed: 287, scanning: false, paused: !!window.indexPaused, lastScan: null, skipped: 0, warnings: [] };
        if (command === 'index_pause') { window.indexPaused = args.paused; return null; }
        if (command === 'index_result_icon') return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
        if (command === 'index_search') {
          if (failFiles) throw new Error('File index is unavailable');
          if (appResult) return [{ id: 2, key: 'registered-app:calculator', kind: 'apps', name: 'Calculator', path: 'shell:AppsFolder\\InternalPackage!App', offline: false, detail: '' }];
          return [{ id: 1, key: 'display', kind: 'actions', name: 'Displays', path: 'ms-settings:display', offline: false, detail: '' }];
        }
        if (command === 'local_settings_panes') return [{ label: 'Displays', icon: '▭', bundleId: 'ms-settings:display' }];
        return null;
      },
    };
  }, { failFiles, platform, appResult });
  await page.goto(`${origin}/launcher/`, { waitUntil: 'networkidle' });
  return page;
}

test('registered apps show display names and native icons and launch by indexed key', async () => {
  const page = await launcher({ appResult: true });
  try {
    const option = page.getByRole('option');
    await option.locator('img.result-icon').waitFor();
    assert.ok(await option.locator('img').evaluate(image => image.complete && image.naturalWidth > 0));
    assert.match(await option.innerText(), /Calculator/);
    assert.doesNotMatch(await option.innerText(), /InternalPackage|APP/);
    await page.getByRole('textbox').press('Enter');
    await page.waitForFunction(() => window.commands.some(([name]) => name === 'index_open_result'));
    assert.deepEqual(await page.evaluate(() => window.commands.find(([name]) => name === 'index_open_result')), ['index_open_result', { key: 'registered-app:calculator' }]);
  } finally { await page.close(); }
});

test('Windows Control+Enter explicitly opens zega without opening the selected setting', async () => {
  const page = await launcher();
  try {
    await page.getByRole('textbox').press('Control+Enter');
    await page.waitForFunction(() => window.commands.some(([name]) => name === 'hide_search_window'));
    const commands = await page.evaluate(() => window.commands.map(([name]) => name));
    assert.ok(commands.includes('show_main_window'), 'Control+Enter must open the main window on Windows');
    assert.ok(!commands.includes('open_settings_pane'), 'the explicit main-window shortcut must not open a result');
  } finally { await page.close(); }
});

test('Windows search has a platform-appropriate accessible name', async () => {
  const page = await launcher();
  try { assert.equal(await page.getByRole('textbox').getAttribute('aria-label'), 'Search this computer'); }
  finally { await page.close(); }
});

test('main search matches the popup and settings has its own navigable page', async () => {
  const page = await launcher();
  const style = () => page.getByRole('textbox').evaluate(input => {
    const box = getComputedStyle(input.closest('form'));
    const text = getComputedStyle(input);
    return { font: text.fontSize, radius: box.borderRadius, padding: box.padding, placeholder: input.placeholder };
  });
  try {
    const popup = await style();
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    assert.deepEqual(await style(), popup);
    assert.doesNotMatch(await page.locator('body').innerText(), /this Mac/);
    assert.equal(await page.getByRole('button', { name: 'Pause indexing' }).count(), 0);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    assert.match(page.url(), /\/settings\/$/);
    await page.getByRole('button', { name: 'Pause indexing', exact: true }).click();
    await page.getByRole('button', { name: 'Resume indexing', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Back to search' }).click();
    await page.getByRole('textbox', { name: 'Search this computer' }).waitFor();
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.deepEqual(await style(), popup);
  } finally { await page.close(); }
});

for (const platform of ['macos', 'linux']) {
  test(`${platform} retains its existing Meta+Enter main-window action`, async () => {
    const page = await launcher({ platform });
    try {
      await page.getByRole('textbox').press('Meta+Enter');
      await page.waitForFunction(() => window.commands.some(([name]) => name === 'hide_search_window'));
      const commands = await page.evaluate(() => window.commands.map(([name]) => name));
      assert.ok(commands.includes('show_main_window'));
      assert.ok(!commands.includes('open_settings_pane'));
    } finally { await page.close(); }
  });
}

test('Windows settings remain actionable when the file index fails', async () => {
  const page = await launcher({ failFiles: true });
  try {
    assert.equal(await page.getByRole('option').count(), 1, 'a file lookup failure must not discard settings');
    await page.getByRole('textbox').fill('Displays');
    await page.getByRole('textbox').press('Enter');
    await page.waitForFunction(() => window.commands.some(([name]) => name === 'hide_search_window'));
    const commands = await page.evaluate(() => window.commands);
    assert.deepEqual(commands.find(([name]) => name === 'open_settings_pane'), ['open_settings_pane', { bundleId: 'ms-settings:display' }]);
    assert.ok(!commands.some(([name]) => name === 'show_main_window'));
  } finally { await page.close(); }
});

test('Windows search keeps 20px text, rounded transparent corners and a 97% surface', async () => {
  const page = await launcher();
  try {
    assert.equal(await page.getByRole('textbox').evaluate(el => getComputedStyle(el).fontSize), '20px');
    assert.match(await page.locator('.float-root').evaluate(el => getComputedStyle(el).backgroundColor), /0, 0, 0, 0|transparent/);
    assert.notEqual(await page.locator('.float-panel').evaluate(el => getComputedStyle(el).borderRadius), '0px');
    assert.match(await page.locator('.float-panel').evaluate(el => getComputedStyle(el).backgroundColor), /\/\s*0\.97\)/);
    await page.getByRole('option').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.commands.some(([name]) => name === 'hide_search_window'));
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally { await page.close(); }
});

test('Windows launcher follows live light and dark system appearance', async () => {
  const page = await launcher();
  try {
    const colors = [];
    for (const colorScheme of ['light', 'dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(mode => matchMedia(`(prefers-color-scheme: ${mode})`).matches, colorScheme);
      colors.push(await page.locator('.float-panel').evaluate(el => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, text: style.color };
      }));
      assert.equal(await page.getByRole('textbox').evaluate(el => getComputedStyle(el).fontSize), '20px');
    }
    assert.notDeepEqual(colors[0], colors[1], 'system theme changes must change the surface palette');
    assert.deepEqual(colors[0], colors[2], 'returning to light must restore the light palette');
  } finally { await page.close(); }
});

test('Windows Use default applies Control+Alt+Space through the native shortcut command', async () => {
  const page = await browser.newPage({ viewport: { width: 480, height: 400 } });
  try {
    await page.addInitScript(() => {
      window.isTauri = true;
      window.commands = [];
      let status = { platform: 'windows', binding: { key: 'KeyK', alt: true, control: true, shift: false, superKey: false }, label: 'Control+Alt+K', registered: true, phase: 'idle', error: null };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        transformCallback() { return 1; },
        async invoke(command, args) {
          window.commands.push([command, args]);
          if (command === 'native_theme') return null;
          if (command === 'local_settings_panes') return [];
          if (command === 'shortcut_apply') status = { ...status, binding: args.binding };
          if (command === 'shortcut_status' || command === 'shortcut_apply') return status;
          return null;
        },
      };
    });
    await page.goto(`${origin}/shortcut/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await page.getByRole('button', { name: 'Use default', exact: true }).click();
    const applied = await page.evaluate(() => window.commands.find(([name]) => name === 'shortcut_apply'));
    assert.deepEqual(applied?.[1].binding, { key: 'Space', alt: true, control: true, shift: false, superKey: false });
    assert.equal(await page.getByRole('button', { name: 'Control+Alt+Space', exact: true }).count(), 1);
  } finally { await page.close(); }
});
