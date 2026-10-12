#!/usr/bin/env node
//MISE description="Render the stable Flatpak manifest for a release"
/* oxlint-disable no-console */

// Usage: render-flatpak-stable.mjs <version> <x86_64-sha256> <aarch64-sha256>
// Pass "-" for an architecture that is not being published.

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const [version, x86, arm] = process.argv.slice(2);

if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !x86 || !arm) {
  console.error('Usage: render-flatpak-stable.mjs <version> <x86_64-sha256> <aarch64-sha256>');
  process.exit(1);
}

const parseArch = (arch, sha) => {
  if (sha === '-') return null;
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    console.error(`${arch}: expected a 64-character sha256 (got: ${sha})`);
    process.exit(1);
  }
  return sha;
};

const arches = { x86_64: parseArch('x86_64', x86), aarch64: parseArch('aarch64', arm) };

if (!arches.x86_64 && !arches.aarch64) {
  console.error('At least one architecture must be published.');
  process.exit(1);
}

const dir = 'packaging/flatpak';
let manifest = readFileSync(`${dir}/moe.sable.client.yml.in`, 'utf8').replaceAll(
  '@VERSION@',
  version
);

for (const [arch, sha] of Object.entries(arches)) {
  if (sha) {
    manifest = manifest.replaceAll(`@SHA256_${arch.toUpperCase()}@`, sha);
    continue;
  }
  const block = new RegExp(
    `      - type: archive\\n(?:        .*\\n|          .*\\n)*?        only-arches: \\[${arch}\\]\\n(?:        x-checker-data:\\n(?:          .*\\n)*)?`
  );
  if (!block.test(manifest)) {
    console.error(`Could not find the ${arch} archive source to drop.`);
    process.exit(1);
  }
  manifest = manifest.replace(block, '');
}

const leftover = manifest.match(/@[A-Z0-9_]+@/);
if (leftover) {
  console.error(`Unsubstituted placeholder left in the manifest: ${leftover[0]}`);
  process.exit(1);
}

writeFileSync(`${dir}/moe.sable.client.yml`, manifest);
console.log(`Rendered the stable Flatpak manifest for ${version}`);
