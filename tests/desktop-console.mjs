import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const server = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'dev', '--port', '1421'],
  { stdio: 'ignore' },
);
let browser;

try {
  let response;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Next dev server exited (${server.exitCode})`);
    try {
      response = await fetch('http://localhost:1421/');
      if (response.ok) break;
    } catch {
      // The server needs time to compile on its first request.
    }
    await delay(500);
  }
  assert.equal(response?.status, 200, 'Next dev server did not serve the landing page');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));

  const loaded = await page.goto('http://localhost:1421/', { waitUntil: 'networkidle' });
  await page.getByRole('main').waitFor();
  await page.waitForFunction(() => document.querySelector('.hello h2')?.textContent?.startsWith('Good '));
  assert.match(await page.locator('.hello h2').innerText(), /^Good (morning|afternoon|evening)/);
  assert.equal(loaded?.status(), 200);
  assert.deepEqual(errors, [], `browser console errors on load: ${errors.join(' | ')}`);
  mkdirSync('.tmp', { recursive: true });
  await page.screenshot({ path: '.tmp/desktop-console-landing.png' });

  const localPage = await browser.newPage();
  localPage.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  localPage.on('pageerror', error => errors.push(error.message));
  await localPage.addInitScript(() => {
    let picturesGranted = false;
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async command => {
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'native_theme') return null;
        if (command === 'shortcut_status') return { registered: true, label: '⌥Space', platform: 'macos' };
        if (command === 'local_recent_files') return [{ name: 'fixture.txt', location: 'Documents', fileType: 'TXT', modifiedLabel: '2 min ago', path: '/Users/test/Documents/fixture.txt' }];
        if (command === 'local_settings_panes') return [];
        if (command === 'local_user_first_name') return 'Test';
        if (command === 'local_pictures_access_granted') return picturesGranted;
        if (command === 'request_pictures_access') { picturesGranted = true; return true; }
        if (command === 'local_recent_photos') return [{ name: 'fixture-photo.jpg', path: '/Users/test/Pictures/fixture-photo.jpg' }];
        throw new Error(`Unexpected fixture command: ${command}`);
      },
      convertFileSrc: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/%3E',
    };
  });
  await localPage.goto('http://localhost:1421/', { waitUntil: 'networkidle' });
  await localPage.getByText('fixture.txt').waitFor();
  assert.match(await localPage.locator('.hello h2').innerText(), /^Good (morning|afternoon|evening), Test$/);
  await localPage.getByRole('button', { name: 'Choose Pictures folder' }).click();
  await localPage.getByAltText('fixture-photo.jpg').waitFor();
  assert.match(await localPage.locator('.photo-tile img').getAttribute('src'), /^data:image\/svg\+xml/);
  await localPage.close();

  const launcher = await browser.newPage({ viewport: { width: 680, height: 440 } });
  const launcherErrors = [];
  launcher.on('console', message => { if (message.type() === 'error') launcherErrors.push(message.text()); });
  launcher.on('pageerror', error => launcherErrors.push(error.message));
  await launcher.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.mockCommands = [];
    window.mainVisible = false;
    const callbacks = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "launcher" } },
      transformCallback: callback => { callbacks.push(callback); return callbacks.length; },
      convertFileSrc: path => `asset://localhost${path}`,
      invoke: async (command, args) => {
        window.mockCommands.push([command, args]);
        if (command === 'show_main_window') window.mainVisible = true;
        if (command === 'native_theme') return null;
        if (command === 'shortcut_status') return { registered: true, label: 'Alt+Space', platform: new URL(location.href).searchParams.get('platform') || 'macos', squareCorners: new URL(location.href).searchParams.has('omarchy') };
        if (command === 'plugin:event|listen') return 1;
        if (command === 'local_recent_files') return [{
          name: 'Local fixture.txt', location: 'Documents', fileType: 'TXT',
          modifiedLabel: 'Just now', path: '/Users/example/Documents/Local fixture.txt',
        }, { name: 'Local fixture.txt', location: 'Downloads', fileType: 'TXT', modifiedLabel: 'Just now', path: '/Users/example/Downloads/Local fixture.txt' }];
        if (command === 'local_settings_panes') return [];
        return null;
      },
    };
  });
  await launcher.goto('http://localhost:1421/launcher/', { waitUntil: 'networkidle' });
  const input = launcher.getByRole('textbox', { name: 'Search this Mac' });
  await launcher.getByText('Local fixture.txt').first().waitFor();
  assert.equal(await launcher.getByText('Local fixture.txt').count(), 2, 'same-named files from different folders remain separate results');
  const rootBackground = await launcher.locator('.float-root').evaluate(element => getComputedStyle(element).backgroundColor);
  assert.match(rootBackground, /0, 0, 0, 0|transparent/);
  const panelBackground = await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).backgroundColor);
  assert.match(panelBackground, /0, 0, 0, 0|transparent/, 'the native material must remain visible');
  assert.equal(await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).boxShadow), 'none', 'no clipped CSS shadow around the native panel');
  for (const height of [340, 440]) {
    await launcher.setViewportSize({ width: 680, height });
    const footer = await launcher.locator('.lfoot').boundingBox();
    assert.ok(footer.y >= 0 && footer.y + footer.height <= height, 'keyboard hints stay inside the window');
    assert.equal(await launcher.evaluate(() => document.documentElement.scrollHeight), height);
  }
  for (const selector of ['.lhead', '.float-word .v', '.lhead .gi']) {
    const before = await launcher.evaluate(() => window.mockCommands.filter(([name]) => name === 'plugin:window|start_dragging').length);
    await launcher.locator(selector).dispatchEvent('mousedown', { button: 0 });
    assert.equal(await launcher.evaluate(() => window.mockCommands.filter(([name]) => name === 'plugin:window|start_dragging').length), before + 1, `${selector} starts a native drag`);
  }
  const drags = await launcher.evaluate(() => window.mockCommands.filter(([name]) => name === 'plugin:window|start_dragging').length);
  assert.equal(await launcher.locator('.lhead .kbd').count(), 0, 'the panel header has no shortcut badge');
  assert.equal(await launcher.getByRole('button', {name: 'Open selected result'}).count(), 0, 'search needs no submit button');
  assert.equal(await input.evaluate(element => getComputedStyle(element).fontSize), '20px', 'search text includes both requested three-pixel increases');
  await input.dispatchEvent('mousedown', { button: 0 });
  await launcher.locator('.lhead').dispatchEvent('mousedown', { button: 2 });
  assert.equal(await launcher.evaluate(() => window.mockCommands.filter(([name]) => name === 'plugin:window|start_dragging').length), drags, 'search editing and right-click do not drag the window');
  await launcher.screenshot({ path: '.tmp/desktop-agent-launcher.png' });
  await input.fill('Downloads');
  await launcher.waitForFunction(() => document.querySelectorAll('.float-group .lrow').length === 1);
  assert.equal(await launcher.getByText('Local fixture.txt').count(), 1, 'typing filters results without submitting');
  await input.fill('');
  await launcher.waitForFunction(() => document.querySelectorAll('.float-group .lrow').length === 2);
  await input.press('ArrowDown');
  await input.press('Enter');
  await launcher.waitForFunction(() => window.mockCommands.some(([name]) => name === 'open_local_file'));
  let commands = await launcher.evaluate(() => window.mockCommands.map(([name]) => name));
  assert.ok(commands.includes('open_local_file'));
  assert.equal(await launcher.evaluate(() => window.mockCommands.find(([name]) => name === 'open_local_file')[1].path), '/Users/example/Downloads/Local fixture.txt', 'the selected duplicate name opens its own file path');
  assert.ok(commands.includes('hide_search_window'));
  assert.ok(!commands.includes('show_main_window'), 'opening a local result never shows zega');
  assert.equal(await launcher.evaluate(() => window.mainVisible), false);

  await launcher.reload({ waitUntil: 'networkidle' });
  await launcher.getByRole('textbox', { name: 'Search this Mac' }).press('Meta+Enter');
  await launcher.waitForFunction(() => window.mockCommands.some(([name]) => name === 'show_main_window'));
  commands = await launcher.evaluate(() => window.mockCommands.map(([name]) => name));
  assert.ok(commands.includes('show_main_window'), 'Command+Return is the explicit main-window action');
  assert.equal(await launcher.evaluate(() => window.mainVisible), true);
  for (const target of ['input', '.float-group .lrow', '.lfoot .local-note']) {
    await launcher.reload({ waitUntil: 'networkidle' });
    await launcher.getByText('Local fixture.txt').first().waitFor();
    if (target === '.lfoot .local-note') await launcher.locator(target).click();
    else await launcher.locator(target).first().focus();
    if (target !== 'input') assert.equal(await launcher.locator('input').evaluate(element => document.activeElement === element), false);
    await launcher.keyboard.press('Escape');
    await launcher.waitForFunction(() => window.mockCommands.some(([name]) => name === 'hide_search_window'), null, { timeout: 2000 });
    assert.equal(await launcher.evaluate(() => window.mockCommands.filter(([name]) => name === 'hide_search_window').length), 1, `Escape from ${target} hides search exactly once`);
    assert.equal(await launcher.getByRole('dialog').count(), 0);
    assert.equal(await launcher.evaluate(() => window.mainVisible), false);
  }
  await launcher.goto('http://localhost:1421/launcher/?platform=linux', { waitUntil: 'networkidle' });
  await launcher.getByText('Local fixture.txt').first().waitFor();
  assert.notEqual(await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).borderRadius), '0px', 'Other Linux desktops retain rounded corners');
  const linuxBackground = await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).backgroundColor);
  assert.match(linuxBackground, /\/\s*0\.97\)/, 'Linux needs a readable translucent surface without macOS material');
  await launcher.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).getPropertyValue('--panel').trim().toLowerCase()), '#161e26', 'system dark mode uses the dark search surface');
  assert.notEqual(await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).backgroundColor), linuxBackground, 'the search surface changes when system appearance changes');
  await launcher.emulateMedia({ colorScheme: 'light' });
  assert.equal(await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).backgroundColor), linuxBackground, 'system light mode restores the light search surface');
  assert.match(await launcher.locator('.float-root').evaluate(element => getComputedStyle(element).backgroundColor), /0, 0, 0, 0|transparent/, 'Linux keeps the rounded corners transparent');
  await launcher.goto('http://localhost:1421/launcher/?platform=linux&omarchy=1', { waitUntil: 'networkidle' });
  assert.equal(await launcher.locator('.float-panel').evaluate(element => getComputedStyle(element).borderRadius), '0px', 'Omarchy uses square panel corners');
  await launcher.screenshot({ path: '.tmp/desktop-linux-launcher.png' });
  assert.deepEqual(launcherErrors, [], `launcher console errors: ${launcherErrors.join(' | ')}`);
  await launcher.close();
  assert.deepEqual(errors, [], `browser console errors during local-data fixture: ${errors.join(' | ')}`);
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
}
