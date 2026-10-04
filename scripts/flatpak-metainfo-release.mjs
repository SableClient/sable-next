#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(
    `Usage: node scripts/flatpak-metainfo-release.mjs <version>  (got: ${version ?? '<none>'})`
  );
  process.exit(1);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = `\n## ${version} (`;
const start = changelog.indexOf(heading);
const date =
  start === -1
    ? undefined
    : changelog.slice(start + heading.length).match(/^(\d{4}-\d{2}-\d{2})\)/)?.[1];
if (!date) {
  console.error(`No "## ${version} (YYYY-MM-DD)" section in CHANGELOG.md`);
  process.exit(1);
}

const path = 'packaging/flatpak/moe.sable.client.metainfo.xml';
const metainfo = readFileSync(path, 'utf8');
if (metainfo.includes(`<release version="${version}"`)) {
  console.log(`${path} already lists ${version}`);
  process.exit(0);
}

const entry = `    <release version="${version}" date="${date}">
      <url type="details">https://git.sable.moe/SableClient/sable-next/releases/tag/v${version}</url>
    </release>
`;
writeFileSync(path, metainfo.replace('  <releases>\n', `  <releases>\n${entry}`));
console.log(`Added ${version} to ${path}`);
