import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin', 'Run this native test on macOS');
assert.ok(process.argv[2], 'Pass the built zega executable as the first argument');
mkdirSync('.tmp', { recursive: true });
const probe = resolve('.tmp/probe-hotkey');
const compilation = spawnSync('clang', ['tests/fixtures/probe-hotkey.c', '-framework', 'Carbon', '-o', probe], { encoding: 'utf8' });
assert.equal(compilation.status, 0, compilation.stderr);
const claimKey = () => spawnSync(probe, { encoding: 'utf8' });
assert.equal(claimKey().status, 0, 'Quit other copies of zega before testing');
const log = openSync('.tmp/shortcut-app.log', 'w');
const app = spawn(resolve(process.argv[2]), [], { stdio: ['ignore', log, log] });
const exited = new Promise(resolve => app.once('exit', resolve));
try {
  let claimed = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assert.equal(app.exitCode, null, 'zega exited before registering the shortcut');
    const result = claimKey();
    if (result.status === 1 && result.stdout.includes('status=-9878')) { claimed = true; break; }
    await delay(250);
  }
  assert.ok(claimed, 'zega must hold an exclusive shortcut, suppressing shared Finder registration');
  console.log('PASS: zega owns Command+Option+Space exclusively');
} finally {
  // Only stop the app process created by this test.
  if (app.exitCode === null) app.kill('SIGTERM');
  await exited;
  closeSync(log);
}
assert.equal(claimKey().status, 0, 'Quitting zega must release the shortcut');
console.log('PASS: quitting releases the key without changing system preferences');
