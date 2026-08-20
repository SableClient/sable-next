#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY ?? 'SableClient/sable-next';
const tag = process.env.TAG;
if (!tag) throw new Error('TAG is required');

const directory = mkdtempSync(join(tmpdir(), 'sable-updater-'));
execFileSync(
  'gh',
  ['release', 'download', tag, '--repo', repository, '--pattern', '*.sig', '--dir', directory],
  {
    stdio: 'inherit',
  }
);

const entries = execFileSync('find', [directory, '-type', 'f', '-name', '*.sig'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((signaturePath) => {
    const name = signaturePath
      .split('/')
      .pop()
      .replace(/\.sig$/, '');
    const signature = readFileSync(signaturePath, 'utf8').trim();
    return [
      name,
      {
        signature,
        url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
      },
    ];
  });

if (entries.length === 0) {
  console.log('No signed assets found; skipping updater manifest.');
  process.exit(0);
}

writeFileSync(
  'latest.json',
  `${JSON.stringify({ version: process.env.VERSION, notes: '', pub_date: new Date().toISOString(), platforms: Object.fromEntries(entries) }, null, 2)}\n`
);
