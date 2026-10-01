#!/usr/bin/env node
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const [version, arch] = process.argv.slice(2);
if (
  !/^\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(version ?? '') ||
  !['x64', 'arm64'].includes(arch)
)
  throw new Error('Usage: normalize-linux-bundles.mjs <version> <x64|arm64>');
for (const [type, extension] of [
  ['deb', '.deb'],
  ['rpm', '.rpm'],
  ['appimage', '.AppImage'],
]) {
  const directory = join('target/release/bundle', type);
  const names = readdirSync(directory).filter((name) => name.endsWith(extension));
  if (names.length !== 1) throw new Error(`Expected exactly one ${type} bundle`);
  const source = join(directory, names[0]);
  const target = join(directory, `sable-next-${version}-linux-${arch}${extension}`);
  if (source === target) continue;
  if (existsSync(target)) throw new Error(`Bundle destination already exists: ${target}`);
  renameSync(source, target);
  if (existsSync(`${source}.sig`)) renameSync(`${source}.sig`, `${target}.sig`);
}
