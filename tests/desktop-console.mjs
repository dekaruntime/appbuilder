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
    window.__TAURI_INTERNALS__ = {
      invoke: async command => {
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
  assert.deepEqual(errors, [], `browser console errors during local-data fixture: ${errors.join(' | ')}`);
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
}
