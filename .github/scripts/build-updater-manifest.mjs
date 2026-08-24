#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY ?? 'SableClient/sable-next';
const tag = process.env.TAG;
const version = process.env.VERSION;
if (!tag) throw new Error('TAG is required');
if (!version) throw new Error('VERSION is required');

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });

const assets = JSON.parse(
  gh('release', 'view', tag, '--repo', repository, '--json', 'assets')
).assets;
const signatures = assets.filter(({ name }) => name.endsWith('.sig'));

if (signatures.length === 0) {
  console.log('No signed assets found; skipping updater manifest.');
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), 'sable-updater-'));
execFileSync(
  'gh',
  ['release', 'download', tag, '--repo', repository, '--pattern', '*.sig', '--dir', directory],
  { stdio: 'inherit' }
);

function targetsFor(name) {
  if (name.endsWith('.app.tar.gz')) return ['darwin-aarch64', 'darwin-x86_64'];
  if (name.endsWith('.AppImage'))
    return [name.includes('-linux-aarch64') ? 'linux-aarch64' : 'linux-x86_64'];
  if (name.endsWith('-setup.exe') || name.endsWith('.msi')) return ['windows-x86_64'];
  return [];
}

const platforms = {};
for (const { name: signatureName } of signatures) {
  const artifact = signatureName.replace(/\.sig$/, '');
  const entry = {
    signature: readFileSync(join(directory, signatureName), 'utf8').trim(),
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(artifact)}`,
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

const notes = gh(
  'release',
  'view',
  tag,
  '--repo',
  repository,
  '--json',
  'body',
  '-q',
  '.body'
).trim();

writeFileSync(
  'latest.json',
  `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`
);
console.log(`Wrote latest.json for ${version}: ${Object.keys(platforms).join(', ')}`);
