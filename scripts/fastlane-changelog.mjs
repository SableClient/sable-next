#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const directory = 'fastlane/metadata/android/en-US/changelogs';
const LIMIT = 500;
const ABI_CODES = { arm: 1, arm64: 2 };
const KINDS = new Set(['feat', 'fix', 'perf']);

const args = process.argv.slice(2);
const check = args.includes('--check');
const force = args.includes('--force');
const [version] = args.filter((arg) => !arg.startsWith('--'));

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `Usage: fastlane-changelog.mjs <version> [--check] [--force]  (got: ${version ?? '<none>'})`
  );
  process.exit(1);
}

const [major, minor, patch] = version.split('.').map(Number);
const base = major * 1_000_000 + minor * 1_000 + patch;
const files = Object.values(ABI_CODES).map((abi) => join(directory, `${base * 10 + abi}.txt`));

if (check) {
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    console.error(
      `Missing fastlane changelogs, run this script and commit them before tagging:\n${missing.join('\n')}`
    );
    process.exit(1);
  }
  process.exit(0);
}

const git = (...gitArgs) =>
  execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function previousTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  } catch {
    return undefined;
  }
}

const tag = previousTag();
const subjects = git('log', '--no-merges', '--format=%s', tag ? `${tag}..HEAD` : 'HEAD').split(
  '\n'
);

const bullets = [];
for (const subject of subjects) {
  const match = /^(\w+)(?:\(([^)]+)\))?!?: (.+)$/.exec(subject);
  if (!match || !KINDS.has(match[1])) continue;
  const text = match[3].replace(/ \(#\d+\)$/, '');
  const bullet = `- ${text[0].toUpperCase()}${text.slice(1)}`;
  if (!bullets.includes(bullet)) bullets.push(bullet);
}

const size = (text) => Buffer.byteLength(text, 'utf8');
let changelog = '';
for (const bullet of bullets) {
  const next = changelog ? `${changelog}\n${bullet}` : bullet;
  if (size(next) > LIMIT) break;
  changelog = next;
}
if (!changelog) {
  console.error('No feat, fix or perf commits to summarise; write the changelog by hand.');
  process.exit(1);
}

mkdirSync(directory, { recursive: true });
for (const file of files) {
  if (existsSync(file) && !force) {
    console.log(`Kept ${file}`);
    continue;
  }
  writeFileSync(file, `${changelog}\n`);
  console.log(`Wrote ${file}`);
}
