import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', '1423'], {stdio: 'ignore'});
const brown = {mode: 'dark', background: '#282828', foreground: '#ebdbb2', muted: '#bdae93', border: '#504945', tint: '#1d2021', accent: '#d79921', accentForeground: '#000000', selection: '#504945', selectionForeground: '#ebdbb2', link: '#83a598'};
const purple = {...brown, background: '#221b30', foreground: '#e5d9f5', accent: '#be95ff', selection: '#49375f', selectionForeground: '#e5d9f5'};
const light = {...brown, mode: 'light', background: '#fafafa', foreground: '#212121', accent: '#3264eb', selection: '#d0d0d0', selectionForeground: '#212121'};
const installed = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : {};
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(server.exitCode, null);
    try { if ((await fetch('http://localhost:1423/')).ok) break; } catch {}
    await delay(500);
  }
  browser = await chromium.launch({headless: true});
  for (const route of ['/', '/launcher/', '/shortcut/']) {
    const page = await browser.newPage({colorScheme: 'dark', viewport: {width: 1000, height: 800}});
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(initial => {
      window.isTauri = true;
      window.themeEvents = {};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener() {}};
      let count = 0;
      const callbacks = {};
      window.__TAURI_INTERNALS__ = {
        transformCallback(callback) { callbacks[++count] = callback; return count; },
        async invoke(command, args) {
          if (command === 'plugin:event|listen') { window.themeEvents[args.event] = callbacks[args.handler]; return count; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'native_theme') return initial;
          if (command === 'shortcut_status') return {platform: 'linux', squareCorners: true, binding: {key: 'KeyZ', alt: false, control: false, shift: false, superKey: true}, label: 'Super+Z', registered: true, phase: 'idle'};
          if (command === 'local_pictures_access_granted') return true;
          if (command === 'local_user_first_name') return null;
          return [];
        },
      };
    }, brown);
    await page.goto(`http://localhost:1423${route}`, {waitUntil: 'networkidle'});
    await page.waitForFunction(() => document.documentElement.dataset.nativeTheme === 'omarchy', null, {timeout: 3000});
    const snapshot = () => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {background: root.getPropertyValue('--bg').trim(), accent: root.getPropertyValue('--accent').trim(), selection: root.getPropertyValue('--var-bg').trim(), scheme: root.colorScheme};
    });
    assert.deepEqual(await snapshot(), {background: brown.background, accent: brown.accent, selection: brown.selection, scheme: 'dark'});
    const surface = route === '/launcher/' ? '.float-panel' : route === '/' ? '.window' : '.shortcut-page';
    if (route === '/launcher/') {
      const background = await page.locator(surface).evaluate(node => getComputedStyle(node).backgroundColor);
      assert.match(background, /0\.156863.*0\.156863.*0\.156863.*0\.92/, 'panel uses actual brown background with unchanged transparency');
    }
    await page.evaluate(value => window.themeEvents['native-theme-changed']({payload: value}), purple);
    assert.deepEqual(await snapshot(), {background: purple.background, accent: purple.accent, selection: purple.selection, scheme: 'dark'});
    await page.evaluate(value => window.themeEvents['native-theme-changed']({payload: value}), light);
    assert.deepEqual(await snapshot(), {background: light.background, accent: light.accent, selection: light.selection, scheme: 'light'});
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForFunction(() => !document.documentElement.dataset.nativeTheme);
    assert.equal((await snapshot()).background.toLowerCase(), '#0b0f14', 'explicit dark overrides the native palette');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase() === '#f5f7f6');
    await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    await page.waitForFunction(() => document.documentElement.dataset.nativeTheme === 'omarchy', null, {timeout: 3000});
    assert.equal((await snapshot()).background, light.background, 'system restores the latest native palette');
    await page.evaluate(() => window.themeEvents['native-theme-changed']({payload: null}));
    assert.equal((await snapshot()).background.toLowerCase(), '#0b0f14', 'missing palette restores system CSS fallback');
    await page.evaluate(value => window.themeEvents['native-theme-changed']({payload: value}), purple);
    for (const [name, palette] of Object.entries(installed)) {
      await page.evaluate(value => window.themeEvents['native-theme-changed']({payload: value}), palette);
      const pixel = await page.locator(route === '/shortcut/' ? 'body' : surface).evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      });
      const expected = [1, 3, 5].map(offset => parseInt(palette.background.slice(offset, offset + 2), 16));
      expected.forEach((value, index) => assert.ok(Math.abs(pixel[index] - value) <= 2, `${route} ${name}: actual surface ${pixel} must match ${palette.background}`));
      assert.equal(pixel[3], route === '/launcher/' ? 235 : 255, `${route} ${name}: preserve opacity`);
    }
    await page.screenshot({path: `.tmp/native-theme-${route === '/' ? 'main' : route.replaceAll('/', '')}.png`});
    assert.deepEqual(errors, [], `${route} console errors`);
    await page.close();
  }
  console.log('PASS: live palettes in main/search/setup, transparency, explicit overrides, missing-palette recovery, zero console errors');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
}
