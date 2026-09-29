#!/usr/bin/env node
// Publish a zega desktop release to the update feed (APS 37).
//
// Ava runs this on the iMac; CI never sees a secret. It takes a CI run's
// built bundles, signs the updater payloads with zega's Ed25519 updater key
// (rule 1), writes the channel manifest (`desktop/<channel>.json`, rule 3),
// uploads everything to the `zega-desktop-releases` R2 bucket, then verifies
// the release by reading the bytes back and comparing sha256 against the
// manifest — never by trusting an upload's exit code.
//
// Usage:
//   node scripts/publish-release.mjs --version 0.2.0 --channel canary \
//     --key ~/.ssh/zega_updater.key [--artifacts <dir> | --run <gha-run-id>] \
//     [--critical] [--minimum-os darwin=14.0] [--dry-run --out <dir>]
//   node scripts/publish-release.mjs --promote --version 0.2.0
//
// --promote flips stable.json to the exact bytes already published on canary
// (same bytes, no rebuild, the aps#68 promotion shape).
//
// Secrets stay in the environment and are never read by this script:
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  passphrase for --key (tauri CLI reads it)
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  wrangler R2 auth
// Missing pieces fail closed with a "Needs Sami:" message.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const BUCKET = 'zega-desktop-releases';
const ORIGIN = 'https://releases.zega.earth';
const PREFIX = 'desktop';
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// The CLI's own JS entry, run with this node: node_modules/.bin/tauri is a
// .cmd shim on Windows, which execFileSync cannot run without a shell.
const TAURI_CLI = path.join(REPO_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
}
function options(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}`) values.push(args[index + 1]);
  }
  return values;
}
const has = name => args.includes(`--${name}`);

function fail(message) {
  console.error(`publish-release: ${message}`);
  process.exit(1);
}

const version = option('version');
if (!version || !/^\d+\.\d+\.\d+(-canary-\w+)?$/.test(version)) {
  fail('pass --version <semver> (e.g. 0.2.0 or 0.2.0-canary-abc123)');
}

// --- --promote: flip stable.json to canary's bytes, no rebuild -------------
if (has('promote')) {
  const manifest = await readBackJson(`${ORIGIN}/${PREFIX}/canary.json`);
  if (manifest.version !== version) {
    fail(`canary.json carries ${manifest.version}, not ${version}; nothing promoted`);
  }
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    await readBackVerify(entry.url, entry.sha256, `canary artifact for ${platform}`);
  }
  uploadJson('stable.json', manifest);
  const stable = await readBackJson(`${ORIGIN}/${PREFIX}/stable.json`);
  if (stable.version !== version) fail('stable.json read-back does not match; promotion failed');
  console.log(`promoted ${version} to stable (same bytes, no rebuild)`);
  process.exit(0);
}

const channel = option('channel');
if (channel !== 'canary' && channel !== 'stable') fail('pass --channel canary|stable');
const dryRun = has('dry-run');
const keyPath = option('key');
if (!keyPath) fail('pass --key <path to the updater private key> (rule 1: no unsigned release)');
if (!existsSync(keyPath)) fail(`key file not found at ${keyPath}`);
if (!existsSync(TAURI_CLI)) fail('tauri CLI missing; run npm ci first');

// --- collect artifacts ------------------------------------------------------
let artifactsDir = option('artifacts');
if (!artifactsDir && option('run')) {
  artifactsDir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'zega-release-'));
  try {
    execFileSync('gh', ['run', 'download', option('run'), '-R', 'zegadb/desktop', '-D', artifactsDir], { stdio: 'inherit' });
  } catch {
    fail(`could not download artifacts for run ${option('run')}`);
  }
}
if (!artifactsDir || !existsSync(artifactsDir)) fail('pass --artifacts <dir> or --run <github run id>');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

// Updater payloads the Tauri updater downloads and installs. With Tauri v2's
// `createUpdaterArtifacts: true`, macOS ships `zega_0.2.0_aarch64.app.tar.gz`,
// while Windows and Linux sign the installer itself: `zega_0.2.0_x64-setup.exe`
// and `zega_0.2.0_amd64.AppImage` are both what a user downloads and what the
// updater installs. The v1-compatible names (`.nsis.zip`, `.AppImage.tar.gz`)
// are still accepted. Classify by family plus an arch token.
function archOf(name) {
  if (/universal/i.test(name)) return 'universal';
  if (/aarch64|arm64/i.test(name)) return 'aarch64';
  if (/x86_64|x64|amd64/i.test(name)) return 'x86_64';
  return null;
}
function classify(name) {
  if (/\.app\.tar\.gz$/.test(name)) return { kind: 'payload', os: 'macos', arch: archOf(name), ext: 'app.tar.gz' };
  if (/\.nsis\.zip$/.test(name)) return { kind: 'payload', os: 'windows', arch: archOf(name) ?? 'x86_64', ext: 'nsis.zip' };
  if (/\.AppImage\.tar\.gz$/.test(name)) return { kind: 'payload', os: 'linux', arch: archOf(name) ?? 'x86_64', ext: 'AppImage.tar.gz' };
  if (/\.dmg$/.test(name)) return { kind: 'installer', os: 'macos', arch: archOf(name), ext: 'dmg' };
  if (/-setup\.exe$/i.test(name)) return { kind: 'both', os: 'windows', arch: archOf(name) ?? 'x86_64', ext: 'exe' };
  if (/\.AppImage$/.test(name)) return { kind: 'both', os: 'linux', arch: archOf(name) ?? 'x86_64', ext: 'AppImage' };
  return null;
}
function platformKeys(os, arch) {
  const osKey = os === 'macos' ? 'darwin' : os;
  if (arch === 'universal') return [`${osKey}-aarch64`, `${osKey}-x86_64`];
  return [`${osKey}-${arch}`];
}

const files = [...walk(artifactsDir)];
const payloads = [];
const installers = [];
for (const file of files) {
  const found = classify(path.basename(file));
  if (!found) continue;
  if (!found.arch) fail(`cannot determine the CPU architecture of ${path.basename(file)}; rename it to include aarch64/x86_64/universal`);
  if (found.kind !== 'installer') payloads.push({ file, ...found, platforms: platformKeys(found.os, found.arch) });
  if (found.kind !== 'payload') installers.push({ file, ...found });
}
if (payloads.length === 0) {
  fail(`no updater payloads (*.app.tar.gz, *-setup.exe, *.AppImage, or v1 *.nsis.zip / *.AppImage.tar.gz) found under ${artifactsDir}`);
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// --- sign (rule 1: every update verifies against zega's own key) ------------
// The private key is only ever opened by the tauri CLI; this script passes the
// path through and never reads it. The passphrase comes from
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD, which the tauri CLI also reads itself.
const staging = dryRun
  ? path.resolve(option('out') ?? fail('--dry-run needs --out <dir>'))
  : mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'zega-release-'));
mkdirSync(staging, { recursive: true });

const minimumOs = Object.fromEntries(options('minimum-os').map(entry => {
  let [os, floor] = entry.split('=');
  if (os === 'darwin') os = 'macos';
  if (!os || !floor) fail(`--minimum-os takes <os>=<version>, got ${entry}`);
  return [os, floor];
}));

// --key is the only key source: `tauri signer sign` rejects -f when
// TAURI_SIGNING_PRIVATE_KEY is also set (as it is in CI, for `tauri build`).
const { TAURI_SIGNING_PRIVATE_KEY: _key, TAURI_SIGNING_PRIVATE_KEY_PATH: _keyPath, ...signerEnv } = process.env;

const platforms = {};
for (const payload of payloads) {
  const canonical = `zega-${version}-${payload.os}-${payload.arch}.${payload.ext}`;
  const staged = path.join(staging, canonical);
  cpSync(payload.file, staged);
  try {
    execFileSync(process.execPath, [TAURI_CLI, 'signer', 'sign', '-f', keyPath, '--app-version', version, staged],
      { stdio: ['ignore', 'ignore', 'pipe'], env: signerEnv });
  } catch (error) {
    fail(`signing ${canonical} failed (Needs Sami: TAURI_SIGNING_PRIVATE_KEY (+ password) on this machine): ${error.stderr}`);
  }
  // The .sig file already holds the base64 minisig the updater plugin expects
  // in the manifest's signature field; do not re-encode it.
  const signature = readFileSync(`${staged}.sig`, 'utf8').trim();
  for (const key of payload.platforms) {
    platforms[key] = {
      url: `${ORIGIN}/${PREFIX}/${canonical}`,
      signature,
      sha256: sha256(staged),
    };
    if (minimumOs[payload.os]) platforms[key].minimum_os = minimumOs[payload.os];
  }
}

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  ...(has('critical') ? { critical: true } : {}),
  platforms,
};

if (dryRun) {
  writeFileSync(path.join(staging, `${channel}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const installer of installers) {
    if (installer.kind === 'both') continue; // already staged and signed above
    cpSync(installer.file, path.join(staging, `zega-${version}-${installer.os}-${installer.arch}.${installer.ext}`));
  }
  console.log(`dry run: signed ${payloads.length} updater payload(s); manifest and artifacts in ${staging}`);
  process.exit(0);
}

// --- upload + read-back verification ---------------------------------------
for (const installer of installers) {
  if (installer.kind === 'both') continue; // uploaded below as a signed payload
  const canonical = `zega-${version}-${installer.os}-${installer.arch}.${installer.ext}`;
  cpSync(installer.file, path.join(staging, canonical));
  uploadFile(canonical, path.join(staging, canonical));
}
for (const payload of new Set(payloads.map(p => `zega-${version}-${p.os}-${p.arch}.${p.ext}`))) {
  uploadFile(payload, path.join(staging, payload));
}
uploadJson(`${channel}.json`, manifest);

for (const [platform, entry] of Object.entries(platforms)) {
  await readBackVerify(entry.url, entry.sha256, `uploaded artifact for ${platform}`);
}
const published = await readBackJson(`${ORIGIN}/${PREFIX}/${channel}.json`);
if (published.version !== version) fail(`${channel}.json read-back does not match; publish failed`);
console.log(`published ${version} to ${channel}: ${Object.keys(platforms).join(', ')} verified by read-back`);

function wrangler() {
  for (const candidate of [path.join(REPO_ROOT, 'node_modules', '.bin', 'wrangler'), 'wrangler']) {
    try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); return candidate; } catch { /* try next */ }
  }
  fail('wrangler not found; install it (npm i -D wrangler) before publishing');
}
function uploadFile(key, file) {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    fail('Needs Sami: CLOUDFLARE_API_TOKEN (R2) in the environment of the publishing machine');
  }
  execFileSync(wrangler(), ['r2', 'object', 'put', `${BUCKET}/${PREFIX}/${key}`, '--file', file, '--remote'],
    { stdio: 'inherit', env: process.env });
}
function uploadJson(key, value) {
  const file = path.join(stagingFor(), key);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  uploadFile(key, file);
}
let stagingMemo = null;
function stagingFor() {
  if (!stagingMemo) stagingMemo = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'zega-release-'));
  return stagingMemo;
}
async function readBackJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) fail(`cannot read back ${url}: HTTP ${response.status}`);
  return response.json();
}
async function readBackVerify(url, expectedSha256, label) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) fail(`cannot read back ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    fail(`read-back sha256 mismatch for ${label} (${url}): manifest ${expectedSha256}, got ${actual}`);
  }
}
