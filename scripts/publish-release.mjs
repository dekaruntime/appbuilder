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
//     [--gpg-home <GNUPGHOME> --gpg-key-id <fingerprint>] \
//     [--critical] [--minimum-os darwin=14.0] [--dry-run --out <dir>]
//   node scripts/publish-release.mjs --promote --version 0.2.0
//
// --promote flips stable.json to the exact bytes already published on canary
// (same bytes, no rebuild, the aps#68 promotion shape).
//
// Linux packages among the artifacts (*.deb, *.pkg.tar.zst) are assembled
// into the flat apt repo (desktop/apt: Packages, Packages.gz, Release,
// InRelease, Release.gpg, zega.asc) and the pacman repo (desktop/arch/$arch:
// package + .sig, zega.db / zega.files + .sig). ONE zega Linux packages key
// signs both repos; the metadata is generated here in pure Node, and gpg does
// every signature — this script never reads the private key. Signing fails
// closed: without --gpg-home and --gpg-key-id (or a usable secret key in
// them) the publish stops before anything is uploaded.
// install/linux.sh is staged at install/linux.sh for the separate
// zega-install bucket (install.zega.earth); this script never touches it.
//
// Secrets stay in the environment and are never read by this script:
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  passphrase for --key (tauri CLI reads it)
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  wrangler R2 auth
// Missing pieces fail closed with a "Needs Sami:" message.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, cpSync, renameSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const BUCKET = 'zega-desktop-releases';
const ORIGIN = 'https://releases.zega.earth';
const PREFIX = 'desktop';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Declared before any top-level code runs: uploadJson() reaches it via
// stagingFor() during the publish, long before the function bodies below.
let stagingMemo = null;
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
  // Package-manager builds (APS 37): the .deb feeds the flat apt repo, the
  // pacman package feeds desktop/arch/$arch. Both are signed with the one
  // zega Linux packages key (see stageAptRepo / stagePacmanRepo).
  if (/\.deb$/.test(name)) return { kind: 'linuxpkg', os: 'linux', arch: archOf(name) ?? 'x86_64', ext: 'deb' };
  if (/\.pkg\.tar\.zst$/.test(name)) return { kind: 'linuxpkg', os: 'linux', arch: archOf(name) ?? 'x86_64', ext: 'pkg.tar.zst' };
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
const linuxPackages = [];
for (const file of files) {
  const found = classify(path.basename(file));
  if (!found) continue;
  if (!found.arch) fail(`cannot determine the CPU architecture of ${path.basename(file)}; rename it to include aarch64/x86_64/universal`);
  if (found.kind === 'linuxpkg') { linuxPackages.push({ file, ...found }); continue; }
  if (found.kind !== 'installer') payloads.push({ file, ...found, platforms: platformKeys(found.os, found.arch) });
  if (found.kind !== 'payload') installers.push({ file, ...found });
}
if (payloads.length === 0) {
  fail(`no updater payloads (*.app.tar.gz, *-setup.exe, *.AppImage, or v1 *.nsis.zip / *.AppImage.tar.gz) found under ${artifactsDir}`);
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const hashFile = (algo, file) => createHash(algo).update(readFileSync(file)).digest('hex');

// --- Linux package repos: one zega packages key signs apt AND pacman --------
// Fail closed BEFORE any signing work: package-manager artifacts without the
// packages key means the publish stops here, never an unsigned repo.
const gpgHome = option('gpg-home');
const gpgKeyId = option('gpg-key-id');
if (linuxPackages.length > 0) {
  if (!gpgHome || !gpgKeyId) {
    fail(`linux packages (${linuxPackages.map(pkg => path.basename(pkg.file)).join(', ')}) are among the artifacts, so pass --gpg-home <GNUPGHOME> and --gpg-key-id <fingerprint>; the apt and pacman repos are never published unsigned`);
  }
  if (!existsSync(gpgHome)) fail(`--gpg-home ${gpgHome} does not exist (Needs Sami: zega Linux packages key on this machine)`);
  gpg(['--list-secret-keys', gpgKeyId],
    `secret key ${gpgKeyId} not found in ${gpgHome} (Needs Sami: zega Linux packages key on this machine)`);
}

// Every gpg call goes through here: --batch --yes, the key is only ever
// opened by gpg itself, and any failure stops the publish (fail closed).
function gpg(args, errorMessage) {
  try {
    return execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--yes', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    fail(`${errorMessage}: ${error.stderr ?? error.message}`);
  }
}
// Binary detached signature <file>.sig, the shape pacman and apt's
// Release.gpg expect.
function gpgDetach(file) {
  gpg(['--local-user', gpgKeyId, '--detach-sign', '--output', `${file}.sig`, file],
    `gpg could not sign ${path.basename(file)} (Needs Sami: the zega Linux packages key must sign from this --gpg-home)`);
}
function gpgExportAscii() {
  return gpg(['--armor', '--export', gpgKeyId], 'gpg could not export the zega Linux packages public key');
}

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

// Stage the apt and pacman repos (signed) next to the updater payloads.
// repoFiles: { key (under desktop/), file, sha256 } for upload + read-back.
const repoFiles = [];
if (linuxPackages.length > 0) {
  const debs = linuxPackages.filter(pkg => pkg.ext === 'deb');
  const pacmanPkgs = linuxPackages.filter(pkg => pkg.ext === 'pkg.tar.zst');
  if (debs.length > 0) repoFiles.push(...stageAptRepo(debs));
  if (pacmanPkgs.length > 0) repoFiles.push(...stagePacmanRepo(pacmanPkgs));
  // The installer script is staged for Ava to publish to the separate
  // zega-install bucket (install.zega.earth/linux.sh); never uploaded here.
  const installScript = path.join(REPO_ROOT, 'packaging', 'install', 'linux.sh');
  if (existsSync(installScript)) {
    mkdirSync(path.join(staging, 'install'), { recursive: true });
    cpSync(installScript, path.join(staging, 'install', 'linux.sh'));
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
  for (const repo of repoFiles) console.log(`dry run: repo file ${repo.key}`);
  if (repoFiles.length > 0) console.log('dry run: install/linux.sh is staged for the zega-install bucket (Ava publishes it; this script never does)');
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
for (const repo of repoFiles) {
  uploadFile(repo.key, repo.file);
}
uploadJson(`${channel}.json`, manifest);

for (const [platform, entry] of Object.entries(platforms)) {
  await readBackVerify(entry.url, entry.sha256, `uploaded artifact for ${platform}`);
}
for (const repo of repoFiles) {
  await readBackVerify(`${ORIGIN}/${PREFIX}/${repo.key}`, repo.sha256, `repo file ${repo.key}`);
}
const published = await readBackJson(`${ORIGIN}/${PREFIX}/${channel}.json`);
if (published.version !== version) fail(`${channel}.json read-back does not match; publish failed`);
console.log(`published ${version} to ${channel}: ${Object.keys(platforms).join(', ')} verified by read-back`);
if (repoFiles.length > 0) {
  console.log(`linux repos: ${repoFiles.length} file(s) under desktop/apt and desktop/arch verified by read-back; install/linux.sh staged for the zega-install bucket (Ava publishes it)`);
}

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

// --- apt flat repo (desktop/apt) --------------------------------------------
// Layout: the .deb(s) next to Packages, Packages.gz, Release, InRelease,
// Release.gpg and the armored public key zega.asc. Users add it with the
// modern signed-by keyring form (packaging/install/linux.sh writes
// /etc/apt/keyrings/zega.asc plus a deb822 .sources file; never apt-key).

function trackRepo(out, key, file) {
  out.push({ key, file, sha256: sha256(file) });
}

function stageAptRepo(debs) {
  const dir = path.join(staging, 'apt');
  mkdirSync(dir, { recursive: true });
  const out = [];
  let packagesText = '';
  for (const deb of debs) {
    const staged = path.join(dir, path.basename(deb.file));
    cpSync(deb.file, staged);
    const control = readDebControl(staged);
    packagesText += control.endsWith('\n') ? control : `${control}\n`;
    packagesText += `Filename: ./${path.basename(staged)}\n`;
    packagesText += `Size: ${statSync(staged).size}\n`;
    packagesText += `MD5sum: ${hashFile('md5', staged)}\n`;
    packagesText += `SHA1: ${hashFile('sha1', staged)}\n`;
    packagesText += `SHA256: ${hashFile('sha256', staged)}\n\n`;
    trackRepo(out, `apt/${path.basename(staged)}`, staged);
  }
  const packagesFile = path.join(dir, 'Packages');
  writeFileSync(packagesFile, packagesText);
  trackRepo(out, 'apt/Packages', packagesFile);
  const packagesGzFile = path.join(dir, 'Packages.gz');
  writeFileSync(packagesGzFile, gzipSync(packagesText));
  trackRepo(out, 'apt/Packages.gz', packagesGzFile);

  const hashStanza = (title, algo) => `${title}:\n` + [packagesFile, packagesGzFile]
    .map(file => ` ${hashFile(algo, file)} ${String(statSync(file).size).padStart(16)} ${path.basename(file)}`)
    .join('\n');
  const releaseFile = path.join(dir, 'Release');
  writeFileSync(releaseFile, `${[
    'Origin: zega',
    'Label: zega',
    'Suite: stable',
    'Codename: zega',
    `Date: ${new Date().toUTCString()}`,
    'Architectures: amd64',
    hashStanza('MD5Sum', 'md5'),
    hashStanza('SHA1', 'sha1'),
    hashStanza('SHA256', 'sha256'),
  ].join('\n')}\n`);
  trackRepo(out, 'apt/Release', releaseFile);

  gpg(['--local-user', gpgKeyId, '--clearsign', '--output', path.join(dir, 'InRelease'), releaseFile],
    'gpg could not clearsign the apt Release file (Needs Sami: the zega Linux packages key must sign from this --gpg-home)');
  trackRepo(out, 'apt/InRelease', path.join(dir, 'InRelease'));
  gpgDetach(releaseFile);
  // apt wants the detached signature under the name Release.gpg.
  renameSync(`${releaseFile}.sig`, path.join(dir, 'Release.gpg'));
  trackRepo(out, 'apt/Release.gpg', path.join(dir, 'Release.gpg'));
  const asc = path.join(dir, 'zega.asc');
  writeFileSync(asc, gpgExportAscii());
  trackRepo(out, 'apt/zega.asc', asc);
  return out;
}

// The control paragraph of a .deb: ar archive → control.tar.gz → the
// `control` member. Pure Node on purpose: the publish machine needs no dpkg.
function readDebControl(debPath) {
  const data = readFileSync(debPath);
  if (data.subarray(0, 8).toString('latin1') !== '!<arch>\n') fail(`${debPath} is not a .deb (bad ar header)`);
  let controlTarGz = null;
  let offset = 8;
  while (offset + 60 <= data.length) {
    const header = data.subarray(offset, offset + 60).toString('latin1');
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || header.slice(58, 60) !== '`\n') fail(`${debPath} is not a .deb (bad ar member at offset ${offset})`);
    if (header.slice(0, 16).trim() === 'control.tar.gz') controlTarGz = data.subarray(offset + 60, offset + 60 + size);
    offset += 60 + size + (size % 2);
  }
  if (!controlTarGz) fail(`${debPath} has no control.tar.gz`);
  const tar = gunzipSync(controlTarGz);
  let tarOffset = 0;
  while (tarOffset + 512 <= tar.length) {
    const block = tar.subarray(tarOffset, tarOffset + 512);
    if (block.every(byte => byte === 0)) break;
    const name = block.subarray(0, 100).toString('latin1').replace(/\0.*$/s, '');
    const size = Number.parseInt(block.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(block[156]);
    if ((name === './control' || name === 'control') && (type === '0' || type === '\0')) {
      return tar.subarray(tarOffset + 512, tarOffset + 512 + size).toString('utf8');
    }
    tarOffset += 512 + Math.ceil(size / 512) * 512;
  }
  fail(`${debPath} has no control file inside control.tar.gz`);
}

// --- pacman repo (desktop/arch/$arch) ----------------------------------------
// Layout per arch: zega-<ver>-1-<arch>.pkg.tar.zst + .sig, and zega.db /
// zega.files (gzipped tar archives of desc/files entries, the repo-add
// shapes) each with a detached .sig. pacman-key --add takes the armored
// public key from desktop/arch/zega.asc (same key as the apt repo).

function stagePacmanRepo(pkgs) {
  const out = [];
  const byArch = new Map();
  for (const pkg of pkgs) {
    const match = /-(x86_64|any)\.pkg\.tar\.zst$/.exec(path.basename(pkg.file));
    if (!match) fail(`cannot determine the pacman architecture of ${path.basename(pkg.file)}`);
    if (!byArch.has(match[1])) byArch.set(match[1], []);
    byArch.get(match[1]).push(pkg.file);
  }
  for (const [arch, files] of byArch) {
    const dir = path.join(staging, 'arch', arch);
    mkdirSync(dir, { recursive: true });
    const entries = [];
    for (const file of files) {
      const staged = path.join(dir, path.basename(file));
      cpSync(file, staged);
      gpgDetach(staged); // the package .sig exists before the db embeds it
      trackRepo(out, `arch/${arch}/${path.basename(staged)}`, staged);
      trackRepo(out, `arch/${arch}/${path.basename(staged)}.sig`, `${staged}.sig`);
      entries.push(readPacmanEntry(staged));
    }
    const dbFile = path.join(dir, 'zega.db');
    writeFileSync(dbFile, pacmanDbTarGz(entries, 'desc'));
    gpgDetach(dbFile);
    trackRepo(out, `arch/${arch}/zega.db`, dbFile);
    trackRepo(out, `arch/${arch}/zega.db.sig`, `${dbFile}.sig`);
    const filesFile = path.join(dir, 'zega.files');
    writeFileSync(filesFile, pacmanDbTarGz(entries, 'files'));
    gpgDetach(filesFile);
    trackRepo(out, `arch/${arch}/zega.files`, filesFile);
    trackRepo(out, `arch/${arch}/zega.files.sig`, `${filesFile}.sig`);
  }
  const asc = path.join(staging, 'arch', 'zega.asc');
  writeFileSync(asc, gpgExportAscii());
  trackRepo(out, 'arch/zega.asc', asc);
  return out;
}

// One package's desc/files data, read from .PKGINFO (tar + zstd handle the
// .pkg.tar.zst; both are on the publish machines) plus hashes of the file.
function readPacmanEntry(pkgPath) {
  const pkginfo = execFileSync('tar', ['-xOf', pkgPath, '.PKGINFO'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const fields = new Map();
  for (const line of pkginfo.split('\n')) {
    const match = /^(\w+) = (.*)$/.exec(line);
    if (!match) continue;
    if (!fields.has(match[1])) fields.set(match[1], []);
    fields.get(match[1]).push(match[2]);
  }
  const one = name => fields.get(name)?.[0];
  for (const required of ['pkgname', 'pkgver', 'pkgdesc', 'arch']) {
    if (!one(required)) fail(`${path.basename(pkgPath)}: .PKGINFO is missing ${required}`);
  }
  const section = (title, values) => (values?.length ? [`%${title}%`, ...values, ''] : []);
  const desc = [
    ...section('FILENAME', [path.basename(pkgPath)]),
    ...section('NAME', [one('pkgname')]),
    ...section('BASE', [one('pkgbase') ?? one('pkgname')]),
    ...section('VERSION', [one('pkgver')]),
    ...section('DESC', [one('pkgdesc')]),
    ...section('GROUPS', fields.get('group')),
    ...section('CSIZE', [String(statSync(pkgPath).size)]),
    ...section('ISIZE', [one('size') ?? '0']),
    ...section('SHA256SUM', [sha256(pkgPath)]),
    ...section('PGPSIG', [readFileSync(`${pkgPath}.sig`).toString('base64')]),
    ...section('URL', fields.get('url')),
    ...section('LICENSE', fields.get('license')),
    ...section('ARCH', [one('arch')]),
    ...section('BUILDDATE', fields.get('builddate')),
    ...section('PACKAGER', fields.get('packager')),
    ...section('REPLACES', fields.get('replaces')),
    ...section('CONFLICTS', fields.get('conflict')),
    ...section('PROVIDES', fields.get('provides')),
    ...section('DEPENDS', fields.get('depend')),
    ...section('OPTDEPENDS', fields.get('optdepend')),
  ].join('\n');
  const fileList = execFileSync('tar', ['-tf', pkgPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(name => name && !name.startsWith('.'));
  const filesText = ['%FILES%', ...fileList, ''].join('\n');
  return { dirname: `${one('pkgname')}-${one('pkgver')}`, desc, files: filesText };
}

function pacmanDbTarGz(entries, kind) {
  const tarEntries = [];
  for (const entry of entries) {
    tarEntries.push({ name: `${entry.dirname}/`, type: '5', body: Buffer.alloc(0) });
    tarEntries.push({ name: `${entry.dirname}/${kind}`, type: '0', body: Buffer.from(kind === 'desc' ? entry.desc : entry.files, 'utf8') });
  }
  return gzipSync(ustar(tarEntries));
}

// Minimal ustar writer: 512-byte headers, ASCII octal fields, GNU-free.
// Entry names in a pacman db are always short enough for the 100-byte field.
function ustar(entries) {
  const chunks = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name) > 100) fail(`tar entry name too long: ${entry.name}`);
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, 'latin1');
    header.write('0000644\0', 100, 8, 'latin1');
    header.write('0000000\0', 108, 8, 'latin1');
    header.write('0000000\0', 116, 8, 'latin1');
    header.write(`${entry.body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'latin1');
    header.write('        ', 148, 8, 'latin1'); // checksum computed over spaces
    header.write(entry.type, 156, 1, 'latin1');
    header.write('ustar\0', 257, 6, 'latin1');
    header.write('00', 263, 2, 'latin1');
    header.write('root', 265, 32, 'latin1');
    header.write('root', 297, 32, 'latin1');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
    chunks.push(header, entry.body);
    const remainder = entry.body.length % 512;
    if (remainder) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
