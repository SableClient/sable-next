import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { valid } from 'semver';
import { parse } from 'smol-toml';
import { tauriVersionConfig } from '../ci/set-tauri-version.mjs';
import { downloadVerified } from '../lib/download.mjs';
import { cargoPackageVersion } from '../lib/cargo.mjs';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'string', short: 'v' },
    target: { type: 'string', short: 't', multiple: true },
    'web-dist': { type: 'string' },
  },
});

function usage() {
  console.log(`Usage: pnpm android:build [--version <version>] [--target <abi>]... [--web-dist <dir>]

Builds the FOSS, per-ABI Android APKs exactly as the release workflow does.
The version defaults to package.json, the target to aarch64 (also: armv7, i686, x86_64).
--web-dist takes web assets already built without Sentry instead of building them.
Requires pnpm, Rust, an Android SDK with the NDK pinned in .mise/config.toml, and tar.
Installs wasm-bindgen-cli from Cargo.lock and Binaryen from .mise/mise.lock as needed.`);
}

if (values.help) {
  usage();
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error?.code === 'ENOENT') throw new Error(`${command} is required on PATH`);
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

const version = (
  values.version ?? JSON.parse(readFileSync('package.json', 'utf8')).version
).replace(/^v/, '');
if (!valid(version)) {
  throw new Error(`--version must be a semver version (got ${version})`);
}

const rustTargets = {
  aarch64: 'aarch64-linux-android',
  armv7: 'armv7-linux-androideabi',
  i686: 'i686-linux-android',
  x86_64: 'x86_64-linux-android',
};
const targets = values.target ?? ['aarch64'];
for (const target of targets) {
  if (!rustTargets[target]) throw new Error(`Unknown --target ${target}`);
}

const ndkVersion = parse(readFileSync('.mise/config.toml', 'utf8')).env?.ANDROID_NDK_VERSION;
if (!ndkVersion) throw new Error('.mise/config.toml does not pin ANDROID_NDK_VERSION');

const projectRoot = process.cwd();
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
const rustupHome = process.env.RUSTUP_HOME ?? join(homedir(), '.rustup');
// The release workflow sets these for its other bundles; the FOSS APK must not
// depend on CI's secrets, nor on the NDK's strip.
const ciOnly = new Set([
  'VITE_SENTRY_DSN',
  'VITE_SENTRY_ENVIRONMENT',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'CARGO_PROFILE_RELEASE_DEBUG',
  'CARGO_PROFILE_RELEASE_STRIP',
]);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !ciOnly.has(name))),
  PATH: [join(cargoHome, 'bin'), process.env.PATH].filter(Boolean).join(delimiter),
  SABLE_FOSS: '1',
  SABLE_BUILD_FLAVOR: 'stable',
  VITE_APP_VERSION: version,
  ANDROID_NDK_VERSION: ndkVersion,
  RUSTFLAGS: [
    process.env.RUSTFLAGS,
    `--remap-path-prefix=${projectRoot}=/usr/src/sable`,
    `--remap-path-prefix=${cargoHome}=/usr/local/cargo`,
    `--remap-path-prefix=${rustupHome}=/usr/local/rustup`,
  ]
    .filter(Boolean)
    .join(' '),
};

run('rustup', ['target', 'add', ...targets.map((target) => rustTargets[target])]);

const webDist = resolve(values['web-dist'] ?? 'dist');
if (!values['web-dist']) await buildWeb();
rmSync(join(webDist, '_app/immutable/workers'), { recursive: true, force: true });

const geolocation = 'src-tauri/capabilities/geolocation.json';
const disabledGeolocation = `${geolocation}.android-build-disabled`;
renameSync(geolocation, disabledGeolocation);

try {
  run(
    'pnpm',
    [
      'tauri',
      'android',
      'build',
      '--config',
      'src-tauri/tauri.ci.conf.json',
      '--config',
      'src-tauri/tauri.stable.conf.json',
      '--config',
      JSON.stringify({
        ...tauriVersionConfig(version),
        build: { frontendDist: relative('src-tauri', webDist) },
      }),
      '--apk',
      '--split-per-abi',
      '--target',
      ...targets,
      '--',
      '--no-default-features',
    ],
    { env }
  );
} finally {
  renameSync(disabledGeolocation, geolocation);
}

async function buildWeb() {
  const lockfile = readFileSync('Cargo.lock', 'utf8');
  const wasmBindgenVersion = cargoPackageVersion(lockfile, 'wasm-bindgen');
  if (!wasmBindgenVersion) throw new Error('Cargo.lock does not contain wasm-bindgen');

  run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  const binaryenBin = await ensureBinaryen();
  if (binaryenBin) env.PATH = [binaryenBin, env.PATH].join(delimiter);
  const wasmBindgen = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8', env });
  if (wasmBindgen.stdout?.trim() !== `wasm-bindgen ${wasmBindgenVersion}`) {
    run('cargo', ['install', 'wasm-bindgen-cli', '--version', wasmBindgenVersion, '--locked'], {
      env,
    });
  }
  run('pnpm', ['build'], { env });
}

async function ensureBinaryen() {
  const lock = parse(readFileSync('.mise/mise.lock', 'utf8'));
  const tool = lock.tools?.['github:WebAssembly/binaryen']?.[0];
  const version = tool?.version;
  if (!version) throw new Error('Binaryen is missing from .mise/mise.lock');

  const matches = (command) => capture(command, ['--version'])?.split(/\s+/)[2] === version;
  if (matches('wasm-opt')) return undefined;

  const platform = `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
  const entry = tool[`platforms.${platform}`];
  const url = entry?.url;
  const checksum = /^sha256:([a-f0-9]{64})$/.exec(entry?.checksum)?.[1];
  if (!url || !checksum) throw new Error(`No locked Binaryen download for ${platform}`);

  const cache = join(process.cwd(), 'node_modules/.cache/binaryen');
  const target = join(cache, `${version}-${platform}-${checksum}`);
  const bin = join(target, 'bin');
  const executable = process.platform === 'win32' ? 'wasm-opt.exe' : 'wasm-opt';
  if (matches(join(bin, executable))) return bin;

  const archive = await downloadVerified(url, checksum);
  mkdirSync(cache, { recursive: true });
  const temporary = mkdtempSync(join(cache, '.tmp-'));
  try {
    const archivePath = join(temporary, 'binaryen.tar.gz');
    writeFileSync(archivePath, archive);
    run('tar', ['-xzf', archivePath, '-C', temporary]);
    const extracted = join(temporary, `binaryen-version_${version}`);
    if (!matches(join(extracted, 'bin', executable))) {
      throw new Error(`Downloaded wasm-opt does not run as Binaryen ${version}`);
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(extracted, target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return bin;
}
