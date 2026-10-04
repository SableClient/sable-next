import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMMUTABLE = '_app/immutable/';
const MANIFEST = '_app/retained.json';
const MAX_AGE_DAYS = 7;
const CONCURRENCY = 8;

export function mergeRetained(previous, current, now, maxAgeDays = MAX_AGE_DAYS) {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const stamp = now.toISOString();
  const files = Object.fromEntries(current.map((path) => [path, stamp]));
  const carry = [];
  for (const [path, seen] of Object.entries(previous)) {
    if (path in files || !path.startsWith(IMMUTABLE) || path.includes('..')) continue;
    if (Date.parse(seen) < cutoff) continue;
    files[path] = seen;
    carry.push(path);
  }
  return { files, carry };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

async function fetchPrevious(site) {
  try {
    const response = await fetch(`${site}/${MANIFEST}`);
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return {};
    const body = await response.json();
    return body && typeof body.files === 'object' ? body.files : {};
  } catch (error) {
    console.warn(`retained manifest unavailable: ${error}`);
    return {};
  }
}

async function download(site, dist, path) {
  const response = await fetch(`${site}/${path}`);
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`${response.status} ${response.headers.get('content-type')}`);
  }
  const target = join(dist, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  const [site, dist] = process.argv.slice(2);
  if (!site || !dist) throw new Error('usage: retain-previous-web-assets.mjs <site-url> <dist>');

  const current = (await listFiles(join(dist, IMMUTABLE))).map((path) => IMMUTABLE + path);
  const { files, carry } = mergeRetained(await fetchPrevious(site), current, new Date());

  const dropped = new Set();
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < carry.length) {
        const path = carry[next++];
        try {
          await download(site, dist, path);
        } catch (error) {
          console.warn(`dropping ${path}: ${error}`);
          dropped.add(path);
        }
      }
    })
  );

  const kept = Object.fromEntries(Object.entries(files).filter(([path]) => !dropped.has(path)));
  await writeFile(join(dist, MANIFEST), JSON.stringify({ files: kept }));
  console.log(`retained ${Object.keys(kept).length - current.length} previous assets`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
