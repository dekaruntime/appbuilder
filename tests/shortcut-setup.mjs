import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', '1422'], { stdio: 'ignore' });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(server.exitCode, null);
    try { if ((await fetch('http://localhost:1422/shortcut/')).ok) break; } catch {}
    await delay(500);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.commands = [];
    window.shortcutStatus = { binding: { key: 'Space', alt: true, control: false, shift: false, superKey: false }, label: '⌥Space', platform: 'macos', registered: false, error: 'Another app holds this shortcut.', phase: 'idle' };
    window.events = {};
    let counter = 0;
    const callbacks = {};
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { callbacks[++counter] = callback; return counter; },
      invoke: async (command, args) => {
        window.commands.push(command);
        if (command === 'plugin:event|listen') { window.events[args.event] = callbacks[args.handler]; return counter; }
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'local_settings_panes') return [{label: 'Keyboard', bundleId: 'com.apple.FixtureKeyboard-Settings.extension'}];
        if (command === 'shortcut_status') return structuredClone(window.shortcutStatus);
        if (command === 'shortcut_apply') {
          window.shortcutStatus = { ...window.shortcutStatus, binding: args.binding, label: '⌃⌥K', registered: true, error: null, phase: 'idle' };
          return structuredClone(window.shortcutStatus);
        }
        if (command === 'shortcut_begin_test') { window.shortcutStatus.phase = 'waiting'; return structuredClone(window.shortcutStatus); }
        if (command === 'shortcut_confirm') {
          if (window.shortcutStatus.phase !== 'received') throw new Error('Native keypress required');
          window.shortcutStatus.phase = 'confirmed'; return structuredClone(window.shortcutStatus);
        }
        if (command === 'open_search_window' || command === 'open_settings_pane') return null;
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('http://localhost:1422/shortcut/', { waitUntil: 'networkidle' });
  await page.getByRole('alert').filter({hasText: 'Another app'}).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start keypress test' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Open search by click' }).click();
  assert.ok((await page.evaluate(() => window.commands)).includes('open_search_window'));
  assert.equal(await page.getByText('Shortcut tested successfully', {exact: false}).count(), 0);
  const recorder = page.getByRole('button', { name: '⌥Space', exact: true });
  await recorder.click();
  await page.getByRole('button', { name: 'Press a combination… (Esc cancels)' }).press('Control+Alt+KeyK');
  await page.getByRole('button', { name: 'Save & check availability' }).click();
  await page.getByText('Registered:', {exact: false}).waitFor();
  assert.deepEqual(await page.locator('main [role=alert]').allTextContents(), []);
  assert.equal(await page.getByText('Shortcut tested successfully', {exact: false}).count(), 0, 'registration alone cannot pass');
  await page.getByRole('button', { name: 'Start keypress test' }).click();
  await page.getByText('Waiting for the global shortcut', {exact: false}).waitFor();
  await page.getByRole('button', { name: 'Open search by click' }).click();
  assert.equal(await page.getByRole('button', { name: 'Only zega opened, and typing worked' }).count(), 0, 'a click is not a keypress');
  await page.evaluate(() => {
    window.shortcutStatus.phase = 'received';
    window.events['shortcut-status']({ payload: structuredClone(window.shortcutStatus) });
  });
  await page.getByRole('button', { name: 'Only zega opened, and typing worked' }).click();
  await page.getByText('Shortcut tested successfully', {exact: false}).waitFor();
  await page.clock.install();
  await page.getByRole('button', { name: 'Start keypress test' }).click();
  await page.clock.fastForward(31_000);
  await page.getByText('No shortcut received in time', {exact: false}).waitFor();
  assert.equal(await page.getByText('Shortcut tested successfully', {exact: false}).count(), 0);
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  await page.getByText('Alt+Space can overlap', {exact: false}).waitFor();
  await page.getByRole('button', { name: 'Linux / Omarchy', exact: true }).click();
  await page.getByText('Linux desktops control', {exact: false}).waitFor();
  await page.getByRole('button', { name: 'macOS', exact: true }).click();
  await page.getByRole('button', { name: 'Open Keyboard Settings' }).click();
  assert.ok((await page.evaluate(() => window.commands)).includes('open_settings_pane'));
  await page.evaluate(() => {
    window.shortcutStatus.platform = 'linux';
    window.events['shortcut-status']({ payload: structuredClone(window.shortcutStatus) });
  });
  await page.getByRole('button', {name: 'Use default', exact: true}).click();
  await page.getByRole('button', {name: 'Super+Z', exact: true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.shortcutStatus.binding), { key: 'KeyZ', alt: false, control: false, shift: false, superKey: true }, 'Use default immediately saves and applies Linux Super+Z without a second Save click');
  await page.screenshot({path: '.tmp/shortcut-setup.png'});
  assert.deepEqual(errors, []);
  console.log('PASS: conflict, customization, click fallback, native event acknowledgement, explicit confirmation, timeout, platform guidance; zero console errors');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
}
