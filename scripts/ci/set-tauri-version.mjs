#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const foldNightlyIntoPatch = args.includes('--apple-short-version');
const setMsiVersion = args.includes('--msi');
const updaterEndpoint = args.find((arg) => arg.startsWith('--updater-endpoint='))?.slice(19) ?? '';
const [version] = args.filter((arg) => !arg.startsWith('--'));

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(
    `Usage: set-tauri-version.mjs <version> [--apple-short-version] [--msi]  (got: ${version ?? '<none>'})`
  );
  process.exit(1);
}

// CFBundleShortVersionString only accepts numeric components, so the nightly
// stamp folds into patch as a Unix timestamp. The YYMMDDHHMMSS form itself
// overflows the u32 Tauri parses each version part into.
let stampedVersion = version;
let wixVersion;
const nightlyVersion =
  /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.[0-9a-f]+)?$/.exec(
    version
  );
const androidVersionCode = nightlyVersion
  ? Date.UTC(
      2000 + +nightlyVersion[4],
      +nightlyVersion[5] - 1,
      +nightlyVersion[6],
      +nightlyVersion[7],
      +nightlyVersion[8],
      +nightlyVersion[9]
    ) / 1000
  : undefined;
if (foldNightlyIntoPatch) {
  if (!nightlyVersion) {
    console.error(`--apple-short-version needs a nightly version (got: ${version})`);
    process.exit(1);
  }
  const [, major, minor] = nightlyVersion;
  const patch = androidVersionCode;
  if (!Number.isInteger(patch) || patch <= 0 || patch > 0xffffffff) {
    console.error(`Nightly stamp does not map to a u32 patch version: ${version}`);
    process.exit(1);
  }
  stampedVersion = `${major}.${minor}.${patch}`;
}

if (setMsiVersion) {
  if (nightlyVersion) {
    const [, major, minor, patch] = nightlyVersion;
    const day = Math.floor(androidVersionCode / 86_400);
    wixVersion = `${major}.${minor}.${patch}.${day % 65_536}`;
  }
}

const file = 'src-tauri/tauri.conf.json';
const config = JSON.parse(readFileSync(file, 'utf8'));
config.version = stampedVersion;
if (wixVersion) {
  config.bundle ??= {};
  config.bundle.windows ??= {};
  config.bundle.windows.wix ??= {};
  config.bundle.windows.wix.version = wixVersion;
}
if (updaterEndpoint) {
  config.plugins ??= {};
  config.plugins.updater ??= {};
  config.plugins.updater.endpoints = [updaterEndpoint];
}
if (androidVersionCode) {
  config.bundle ??= {};
  config.bundle.android ??= {};
  config.bundle.android.versionCode = androidVersionCode;
}
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Set ${file} version to ${stampedVersion}`);
if (wixVersion) console.log(`Set ${file} MSI version to ${wixVersion}`);
