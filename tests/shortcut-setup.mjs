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
  const page = await browser.newPage({viewport: {width: 480, height: 400}});
  const fits = async () => {
    const dimensions = await page.evaluate(() => ({width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight}));
    assert.ok(dimensions.scrollHeight <= dimensions.height && dimensions.scrollWidth <= dimensions.width, `Setup must fit without scrolling: ${JSON.stringify(dimensions)}`);
    // Measure every button in one evaluate: listing locators and then measuring them one by one races re-renders.
    const unreachable = await page.evaluate(height => [...document.querySelectorAll('button')].map(button => button.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0 && (box.top < 0 || box.bottom > height)).length, dimensions.height);
    assert.equal(unreachable, 0, 'Every visible button must be reachable without scrolling');
  };
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.commands = [];
    window.shortcutStatus = { binding: { key: 'Space', alt: true, control: false, shift: false, superKey: false }, label: '⌥Space', platform: 'macos', registered: false, error: 'Super+Space is already used by the desktop input-source shortcut. Choose another combination or change it in Keyboard Settings.', phase: 'idle' };
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
        if (command === 'native_theme') return null;
        if (command === 'shortcut_status') return new Promise(resolve => { window.releaseShortcutStatus = () => resolve(structuredClone(window.shortcutStatus)); });
        if (command === 'shortcut_apply') {
          if (args.binding.key === 'Space' && !args.binding.control) return structuredClone(window.shortcutStatus);
          window.shortcutStatus = { ...window.shortcutStatus, binding: args.binding, label: '⌃⌥K', registered: true, error: null, phase: 'idle' };
          return structuredClone(window.shortcutStatus);
        }
        if (command === 'shortcut_begin_test') { window.shortcutStatus.phase = 'waiting'; return structuredClone(window.shortcutStatus); }
        if (command === 'shortcut_confirm') {
          if (window.shortcutStatus.phase !== 'received') throw new Error('Native keypress required');
          window.shortcutStatus.phase = 'confirmed'; return structuredClone(window.shortcutStatus);
        }
        if (command === 'open_search_window' || command === 'open_settings_pane' || command === 'close_shortcut_setup') return null;
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('http://localhost:1422/shortcut/', { waitUntil: 'networkidle' });
  await page.getByRole('button', {name: 'Loading…', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Save & test'}).isDisabled(), true, 'Do not offer a guessed platform shortcut while native settings load');
  await page.evaluate(() => window.releaseShortcutStatus());
  await page.getByRole('alert').filter({hasText: 'already used'}).waitFor();
  await fits();
  await page.getByRole('button', { name: 'Save & test' }).click();
  assert.ok(!(await page.evaluate(() => window.commands)).includes('shortcut_begin_test'), 'A conflict cannot start the keypress test');
  await page.getByRole('button', { name: 'Open search', exact: true }).click();
  assert.ok((await page.evaluate(() => window.commands)).includes('open_search_window'));
  assert.equal(await page.getByText('Shortcut tested successfully', {exact: false}).count(), 0);
  const recorder = page.getByRole('button', { name: '⌥Space', exact: true });
  await recorder.click();
  await page.getByRole('button', { name: 'Press a combination… (Esc cancels)' }).press('Control+Alt+KeyK');
  await page.getByRole('button', { name: 'Save & test' }).click();
  await page.getByText('Switch to another app and press', {exact: false}).waitFor();
  await fits();
  assert.deepEqual(await page.locator('main [role=alert]').allTextContents(), []);
  assert.equal(await page.getByText('Shortcut tested successfully', {exact: false}).count(), 0, 'registration alone cannot pass');
  await page.getByRole('button', { name: 'Open search', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Yes, it worked' }).count(), 0, 'a click is not a keypress');
  await page.evaluate(() => {
    window.shortcutStatus.phase = 'received';
    window.events['shortcut-status']({ payload: structuredClone(window.shortcutStatus) });
  });
  await page.getByText('Keypress received.', {exact: false}).waitFor();
  await fits();
  await page.getByRole('button', { name: 'Yes, it worked' }).click();
  await page.getByText('Shortcut tested successfully', {exact: false}).waitFor();
  await fits();
  await page.getByRole('button', {name: 'Done', exact: true}).click();
  assert.ok((await page.evaluate(() => window.commands)).includes('close_shortcut_setup'));
  await page.evaluate(() => { window.shortcutStatus.phase = 'idle'; window.events['shortcut-status']({payload: structuredClone(window.shortcutStatus)}); });
  await page.clock.install();
  await page.getByRole('button', { name: 'Test shortcut' }).click();
  await page.clock.fastForward(31_000);
  await page.getByText('No shortcut received.', {exact: false}).waitFor();
  await fits();
  assert.equal(await page.getByText('Shortcut tested successfully', {exact: false}).count(), 0);
  await page.getByRole('button', {name: 'Help', exact: true}).click();
  await fits();
  await page.getByRole('button', { name: 'Open Keyboard Settings' }).click();
  assert.ok((await page.evaluate(() => window.commands)).includes('open_settings_pane'));
  for (const platform of ['windows', 'linux']) {
    await page.evaluate(platform => { window.shortcutStatus.platform = platform; window.events['shortcut-status']({payload: structuredClone(window.shortcutStatus)}); }, platform);
    await fits();
  }
  await page.getByRole('button', {name: 'Back', exact: true}).click();
  await page.evaluate(() => {
    window.shortcutStatus.platform = 'linux';
    window.events['shortcut-status']({ payload: structuredClone(window.shortcutStatus) });
  });
  await page.getByRole('button', {name: 'Change', exact: true}).click();
  await fits();
  await page.getByRole('button', {name: 'Use default', exact: true}).click();
  await page.getByRole('button', {name: 'Super+Z', exact: true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.shortcutStatus.binding), { key: 'KeyZ', alt: false, control: false, shift: false, superKey: true }, 'Use default immediately saves and applies Linux Super+Z without a second Save click');
  await fits();
  await page.screenshot({path: '.tmp/shortcut-setup.png'});
  await page.getByRole('button', {name: 'Change', exact: true}).click();
  await page.getByLabel('Key', {exact: true}).selectOption('KeyJ');
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.getByRole('button', {name: 'Super+Z', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Change', exact: true}).click();
  await page.getByLabel('Key', {exact: true}).selectOption('KeyJ');
  await fits();
  await page.getByRole('button', {name: 'Save & test', exact: true}).click();
  assert.equal(await page.evaluate(() => window.shortcutStatus.binding.key), 'KeyJ');
  await fits();
  assert.deepEqual(errors, []);
  console.log('PASS: conflict, customization, click fallback, native event acknowledgement, explicit confirmation, timeout, platform guidance; zero console errors');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
}
