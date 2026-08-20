#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const foldNightlyIntoPatch = args.includes('--apple-short-version');
const msiVersion = args.includes('--msi');
const updaterEndpoint = args.find((arg) => arg.startsWith('--updater-endpoint='))?.slice(19) ?? '';
const [version] = args.filter((arg) => !arg.startsWith('--'));

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(
    `Usage: set-tauri-version.mjs <version> [--apple-short-version]  (got: ${version ?? '<none>'})`
  );
  process.exit(1);
}

// CFBundleShortVersionString only accepts numeric components, so the nightly
// stamp folds into patch as a Unix timestamp. The YYMMDDHHMMSS form itself
// overflows the u32 Tauri parses each version part into.
let stampedVersion = version;
if (foldNightlyIntoPatch) {
  const nightly = /^(\d+\.\d+)\.\d+-nightly\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    version
  );
  if (!nightly) {
    console.error(`--apple-short-version needs a nightly version (got: ${version})`);
    process.exit(1);
  }
  const [, base, yy, mm, dd, hh, min, sec] = nightly;
  const patch = Date.UTC(2000 + +yy, mm - 1, +dd, +hh, +min, +sec) / 1000;
  if (!Number.isInteger(patch) || patch <= 0 || patch > 0xffffffff) {
    console.error(`Nightly stamp does not map to a u32 patch version: ${version}`);
    process.exit(1);
  }
  stampedVersion = `${base}.${patch}`;
}

if (msiVersion) {
  const nightly = /^(\d+\.\d+\.\d+)-nightly\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    version
  );
  if (nightly) {
    const [, base, yy, mm, dd] = nightly;
    const day = Date.UTC(2000 + +yy, +mm - 1, +dd) / 86_400_000;
    stampedVersion = `${base}-${day % 65_536}`;
  }
}

const file = 'src-tauri/tauri.conf.json';
const config = JSON.parse(readFileSync(file, 'utf8'));
config.version = stampedVersion;
if (updaterEndpoint) {
  config.plugins ??= {};
  config.plugins.updater ??= {};
  config.plugins.updater.endpoints = [updaterEndpoint];
}
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Set ${file} version to ${stampedVersion}`);
