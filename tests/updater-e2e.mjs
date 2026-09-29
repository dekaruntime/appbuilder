#!/usr/bin/env node
// End-to-end proof of the APS 37 updater against a local fake update server.
//
// Subcommands (`all` runs build + the three scenarios in order):
//   build         throwaway Ed25519 keys in .tmp, then version N and N+1 builds
//                 pointed at the fake server (the shipped endpoint is untouched)
//   good          N checks, finds N+1, verifies the signature, installs and
//                 relaunches as N+1 (the manifest marks N+1 critical, so it
//                 applies at the next idle moment — no UI interaction needed)
//   tampered      the payload is signed by an attacker key; the app refuses it,
//                 stays on N and keeps working
//   unreachable   the server is down; startup neither crashes nor hangs
//   revert-prove  rebuild N with the plugin's signature verification neutered
//                 and re-run `tampered`: the bad update now installs, proving
//                 the tampered scenario really guards the signature check
//
// Keys are throwaway, generated into .tmp/updater-e2e at test time. The real
// updater key is never touched. Usage: node tests/updater-e2e.mjs [all|build|…]

import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TAURI_CLI = path.join(REPO_ROOT, 'node_modules', '.bin', 'tauri');
const WORK = path.join(REPO_ROOT, '.tmp', 'updater-e2e');
const PORT = 48741;
const VERSION_N = '0.1.0';
const VERSION_NEXT = '0.1.1';
const APP = path.join(REPO_ROOT, '.target', 'release', 'bundle', 'macos', 'zega.app');
const PAYLOAD = `${APP}.tar.gz`;
const PLATFORM = `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;

process.env.TMPDIR = path.join(REPO_ROOT, '.tmp');
process.env.CARGO_TARGET_DIR = path.join(REPO_ROOT, '.target');

class ScenarioError extends Error {}

function fail(message) {
  console.error(`updater-e2e: FAIL: ${message}`);
  process.exit(1);
}
function ok(message) {
  console.log(`updater-e2e: ${message}`);
}
function run(command, argv, options = {}) {
  execFileSync(command, argv, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
}

const keyPath = name => path.join(WORK, name);
const pubkey = name => readFileSync(`${keyPath(name)}.pub`, 'utf8').trim();

function build(version) {
  const config = JSON.stringify({
    version,
    build: { beforeBuildCommand: '' },
    bundle: { targets: ['app'] },
    plugins: { updater: {
      endpoints: [`http://127.0.0.1:${PORT}/desktop/{channel}.json`],
      pubkey: pubkey('updater.key'),
      // Test builds only: the fake update server is plain-http loopback. The
      // shipped configuration stays https-only on the permanent APS 37 URL.
      dangerousInsecureTransportProtocol: true,
    } },
  });
  // The throwaway key lets `tauri build` produce a signed updater payload and
  // exit 0; the real key is never anywhere near this machine's test runs.
  run(TAURI_CLI, ['build', '--config', config], {
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath('updater.key'), 'utf8'),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    },
  });
  if (!existsSync(APP)) throw new ScenarioError(`build ${version} produced no app at ${APP}`);
  const staged = path.join(WORK, `zega-${version}.app`);
  rmSync(staged, { recursive: true, force: true });
  cpSync(APP, staged, { recursive: true });
  if (version === VERSION_NEXT) {
    if (!existsSync(PAYLOAD)) throw new ScenarioError(`build ${version} produced no updater payload at ${PAYLOAD}`);
    cpSync(PAYLOAD, path.join(WORK, `zega-${version}.app.tar.gz`));
    cpSync(`${PAYLOAD}.sig`, path.join(WORK, `zega-${version}.app.tar.gz.sig`));
    // The tampered scenario serves the same bytes signed by the wrong key.
    cpSync(PAYLOAD, path.join(WORK, `zega-${version}-attacker.app.tar.gz`));
    run(TAURI_CLI, ['signer', 'sign', '-f', keyPath('attacker.key'), '--app-version', version,
      path.join(WORK, `zega-${version}-attacker.app.tar.gz`)]);
  }
  ok(`built and staged version ${version}`);
}

function manifest(signatureFile) {
  // The .sig file already holds the base64 minisig the updater expects.
  const signature = readFileSync(signatureFile, 'utf8').trim();
  return JSON.stringify({
    version: VERSION_NEXT,
    pub_date: new Date().toISOString(),
    critical: true,
    platforms: { [PLATFORM]: { url: `http://127.0.0.1:${PORT}/desktop/payload`, signature } },
  });
}

// Serves the channel manifest at both stable.json and canary.json (so the
// app's channel choice cannot affect the scenario) plus the update payload.
function serve(signatureFile, payloadFile) {
  const body = manifest(signatureFile);
  const server = createServer((request, response) => {
    if (request.url?.endsWith('.json')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    } else if (request.url === '/desktop/payload') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(payloadFile));
    } else {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// Launches the staged version-N app and watches its stderr log.
function launchApp(scenario) {
  const dir = path.join(WORK, `run-${scenario}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(WORK, `zega-${VERSION_N}.app`), path.join(dir, 'zega.app'), { recursive: true });
  const binary = path.join(dir, 'zega.app', 'Contents', 'MacOS', 'zega-desktop');
  const logFile = path.join(dir, 'app.log');
  const out = openSync(logFile, 'w');
  const child = spawn(binary, [], { stdio: ['ignore', out, out] });
  const log = () => readFileSync(logFile, 'utf8');
  function waitFor(needle, timeoutMs, description) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (log().includes(needle)) { clearInterval(poll); resolve(); }
        else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new ScenarioError(`timed out waiting for ${description ?? JSON.stringify(needle)}\n--- app log ---\n${log()}`));
        }
      }, 250);
    });
  }
  const alive = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  // After an update the RELAUNCHED process has a new pid; stop every process
  // running this scenario's binary (all descendants of the one we started —
  // the path is unique to this test, so no pattern-kill can hit anything else).
  const stop = () => {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    try {
      const pids = execFileSync('pgrep', ['-f', `updater-e2e/run-${scenario}/zega.app`]).toString().trim();
      for (const pid of pids.split('\n').filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
      }
    } catch { /* pgrep found nothing */ }
  };
  return { log, waitFor, alive, stop };
}

async function scenarioGood() {
  const server = await serve(path.join(WORK, `zega-${VERSION_NEXT}.app.tar.gz.sig`), path.join(WORK, `zega-${VERSION_NEXT}.app.tar.gz`));
  const app = launchApp('good');
  try {
    await app.waitFor(`zega desktop ${VERSION_N} ready`, 60_000, 'version N startup');
    await app.waitFor(`zega update: ${VERSION_NEXT} is critical; applying at the next idle moment`, 90_000, 'the signed N+1 download');
    // The critical update applies and the app relaunches itself as N+1.
    await app.waitFor(`zega desktop ${VERSION_NEXT} ready`, 90_000, 'the relaunch as N+1');
    ok(`good: ${VERSION_N} verified, installed and relaunched as ${VERSION_NEXT}`);
  } finally {
    app.stop();
    server.close();
  }
}

async function scenarioTampered() {
  const server = await serve(path.join(WORK, `zega-${VERSION_NEXT}-attacker.app.tar.gz.sig`), path.join(WORK, `zega-${VERSION_NEXT}-attacker.app.tar.gz`));
  const app = launchApp('tampered');
  try {
    await app.waitFor(`zega desktop ${VERSION_N} ready`, 60_000, 'version N startup');
    await app.waitFor(`refused update ${VERSION_NEXT}`, 90_000, 'the signature refusal');
    // Give any wrongful apply a chance to happen, then assert it did not.
    await new Promise(resolve => setTimeout(resolve, 15_000));
    if (app.log().includes(`zega desktop ${VERSION_NEXT} ready`)) {
      throw new ScenarioError('tampered payload was installed');
    }
    if (!app.alive()) throw new ScenarioError('app died after refusing the tampered update');
    ok(`tampered: bad signature refused; app stays on ${VERSION_N} and keeps running`);
  } finally {
    app.stop();
    server.close();
  }
}

async function scenarioUnreachable() {
  // Nothing listens on PORT: the manifest fetch fails. Startup must not hang.
  const app = launchApp('unreachable');
  const started = Date.now();
  try {
    await app.waitFor(`zega desktop ${VERSION_N} ready`, 60_000, 'startup with a dead update server');
    const startupMs = Date.now() - started;
    await app.waitFor('zega update: check failed', 60_000, 'the failed check');
    if (!app.alive()) throw new ScenarioError('app died with the update server unreachable');
    ok(`unreachable: app ready in ${startupMs}ms, check failed cleanly, no crash and no hang`);
  } finally {
    app.stop();
  }
}

async function scenarioRevertProve() {
  // Neuter verify_signature in a vendored copy of the updater plugin and
  // rebuild N against it. With the check gone, the tampered payload MUST
  // install; if the tampered scenario still passes, it guards nothing.
  const registry = execFileSync('bash', ['-c', 'echo ~/.cargo/registry/src/*/tauri-plugin-updater-2*/']).toString().trim();
  const vendored = path.join(WORK, 'tauri-plugin-updater-neutered');
  rmSync(vendored, { recursive: true, force: true });
  cpSync(registry, vendored, { recursive: true });
  const updaterRs = path.join(vendored, 'src', 'updater.rs');
  const source = readFileSync(updaterRs, 'utf8');
  const anchor = 'let signature_base64_decoded = base64_to_string(release_signature)?;';
  if (!source.includes(anchor)) throw new ScenarioError('could not find the signature check in the vendored plugin');
  writeFileSync(updaterRs, source.replace(anchor, `{ let _ = release_signature; return Ok(()); }; let signature_base64_decoded = String::new();`));
  const cargoToml = path.join(REPO_ROOT, 'src-tauri', 'Cargo.toml');
  const lockfile = path.join(REPO_ROOT, 'src-tauri', 'Cargo.lock');
  const tomlBackup = readFileSync(cargoToml, 'utf8');
  const lockBackup = readFileSync(lockfile, 'utf8');
  try {
    appendFileSync(cargoToml, `\n[patch.crates-io]\ntauri-plugin-updater = { path = "${vendored}" }\n`);
    build(VERSION_N);
    // With verification neutered, the attacker-signed payload must install
    // and relaunch as N+1. A refusal here would mean the tampered scenario
    // guards something other than the signature check.
    const server = await serve(path.join(WORK, `zega-${VERSION_NEXT}-attacker.app.tar.gz.sig`), path.join(WORK, `zega-${VERSION_NEXT}-attacker.app.tar.gz`));
    const app = launchApp('tampered');
    try {
      await app.waitFor(`zega desktop ${VERSION_N} ready`, 60_000, 'version N startup');
      await app.waitFor(`zega desktop ${VERSION_NEXT} ready`, 120_000, 'the neutered install of the tampered payload');
      if (app.log().includes(`refused update ${VERSION_NEXT}`)) {
        throw new ScenarioError('tampered payload was refused even with the check neutered; the scenario is decoration');
      }
      ok('revert-prove: with the check neutered the tampered payload INSTALLS and relaunches — the tampered scenario guards the signature check');
    } finally {
      app.stop();
      server.close();
    }
  } finally {
    // Restore manifest and lockfile byte-for-byte and rebuild a clean N;
    // the neutered plugin must never survive the test.
    writeFileSync(cargoToml, tomlBackup);
    writeFileSync(lockfile, lockBackup);
    build(VERSION_N);
  }
}

const scenarios = { good: scenarioGood, tampered: scenarioTampered, unreachable: scenarioUnreachable };

async function main() {
  mkdirSync(WORK, { recursive: true });
  const which = process.argv[2] ?? 'all';
  if (which === 'build' || which === 'all') {
    for (const key of ['updater.key', 'attacker.key']) {
      if (!existsSync(keyPath(key))) {
        run(TAURI_CLI, ['signer', 'generate', '-w', keyPath(key), '-p', '', '-f'], { env: { ...process.env, CI: 'true' } });
      }
    }
    if (!existsSync(path.join(REPO_ROOT, 'out', 'index.html'))) run('npm', ['run', 'build:desktop']);
    build(VERSION_N);
    build(VERSION_NEXT);
  }
  if (which === 'revert-prove') {
    await scenarioRevertProve();
    ok('revert-prove: PASS');
    return;
  }
  const names = which === 'all' ? Object.keys(scenarios) : [which];
  for (const name of names) {
    const scenario = scenarios[name];
    if (!scenario) fail(`unknown scenario ${name}`);
    await scenario();
    ok(`${name}: PASS`);
  }
}

main().catch(error => fail(error.message ?? String(error)));
