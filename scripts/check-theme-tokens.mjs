import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = join(root, 'src');
const tokenPattern = /--sable-[a-z0-9-]+/g;
const declarationPattern = /--sable-[a-z0-9-]+\s*:/g;
const sourceExtensions = new Set(['.css', '.svelte', '.ts']);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      files.push(path);
    }
  }

  return files;
}

const files = await sourceFiles(sourceRoot);
const declared = new Set();
const referenced = new Map();

for (const file of files) {
  const source = await readFile(file, 'utf8');

  for (const match of source.matchAll(declarationPattern)) {
    declared.add(match[0].replace(/\s*:/, ''));
  }

  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const line = source.slice(0, match.index).split('\n').length;
    const locations = referenced.get(token) ?? [];
    locations.push(`${relative(root, file)}:${line}`);
    referenced.set(token, locations);
  }
}

const missing = [...referenced.keys()].filter((token) => !declared.has(token)).sort();

if (missing.length > 0) {
  console.error('Unknown Sable theme tokens:');
  for (const token of missing) {
    console.error(`  ${token} (${referenced.get(token).join(', ')})`);
  }
  process.exitCode = 1;
} else {
  console.log(`Checked ${referenced.size} Sable theme tokens; all are declared.`);
}
