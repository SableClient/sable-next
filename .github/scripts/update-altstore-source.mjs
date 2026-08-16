#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const [sourcePath, version, sizeStr, downloadURL, date, description] = process.argv.slice(2);
if (!sourcePath || !version || !sizeStr || !downloadURL || !date || !description) {
  console.error(
    'Usage: update-altstore-source.mjs <source.json> <version> <ipa-size> <downloadURL> <date> <description>'
  );
  process.exit(1);
}

const size = Number(sizeStr);
if (!Number.isInteger(size) || size <= 0) {
  console.error(`ipa-size must be a positive integer (got: ${sizeStr})`);
  process.exit(1);
}

const maxVersions = Number(process.env.ALTSTORE_MAX_VERSIONS ?? 20);
if (!Number.isInteger(maxVersions) || maxVersions <= 0) {
  console.error(`ALTSTORE_MAX_VERSIONS must be a positive integer (got: ${maxVersions})`);
  process.exit(1);
}

const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const app = source.apps?.[0];
if (!app) {
  console.error(`${sourcePath} has no apps[0] to update.`);
  process.exit(1);
}

// CFBundleShortVersionString keeps only digits and dots, and AltStore matches
// against that.
const normalized = version
  .replace(/-nightly\./g, '.')
  .replace(/[^0-9.]/g, '.')
  .replace(/\.+/g, '.')
  .replace(/^\.|\.$/g, '');

const entry = {
  version: normalized,
  buildVersion: normalized,
  date,
  size,
  downloadURL,
  localizedDescription: description,
};

const versions = Array.isArray(app.versions) ? app.versions : [];
const existing = versions.findIndex((candidate) => candidate.version === normalized);
if (existing >= 0) versions[existing] = entry;
else versions.unshift(entry);

app.versions = versions.slice(0, maxVersions);
writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
console.log(`Updated ${sourcePath}: ${app.bundleIdentifier} ${normalized} -> ${downloadURL}`);
