#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = (process.env.FORGEJO_URL ?? 'https://git.sable.moe').replace(/\/+$/, '');
const repository = process.env.FORGEJO_REPOSITORY ?? 'SableClient/sable-next';
const tag = process.env.TAG;
const version = process.env.VERSION;
if (!tag) throw new Error('TAG is required');
if (!version) throw new Error('VERSION is required');

const release = join(dirname(fileURLToPath(import.meta.url)), 'forgejo-release.mjs');
const run = (...args) => execFileSync('node', [release, ...args], { encoding: 'utf8' });

const assets = run('assets', '--tag', tag).split('\n').filter(Boolean);
const signatures = assets.filter((name) => name.endsWith('.sig'));

if (signatures.length === 0) {
  console.log('No signed assets found; skipping updater manifest.');
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), 'sable-updater-'));
run('download', '--tag', tag, '--pattern', '*.sig', '--dir', directory);

function targetsFor(name) {
  if (name.endsWith('.app.tar.gz')) return ['darwin-aarch64', 'darwin-x86_64'];
  if (name.endsWith('.AppImage'))
    return [name.includes('-linux-aarch64') ? 'linux-aarch64' : 'linux-x86_64'];
  if (name.endsWith('-setup.exe') || name.endsWith('.msi')) return ['windows-x86_64'];
  return [];
}

const platforms = {};
for (const signatureName of signatures) {
  const artifact = signatureName.replace(/\.sig$/, '');
  const entry = {
    signature: readFileSync(join(directory, signatureName), 'utf8').trim(),
    url: `${server}/${repository}/releases/download/${tag}/${encodeURIComponent(artifact)}`,
  };
  for (const target of targetsFor(artifact)) {
    if (target === 'windows-x86_64' && platforms[target] && artifact.endsWith('.msi')) continue;
    platforms[target] = entry;
  }
}

if (Object.keys(platforms).length === 0) {
  console.log('No signed assets map to an updater target; skipping updater manifest.');
  process.exit(0);
}

const notes = run('body', '--tag', tag).trim();

writeFileSync(
  'latest.json',
  `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`
);
console.log(`Wrote latest.json for ${version}: ${Object.keys(platforms).join(', ')}`);
