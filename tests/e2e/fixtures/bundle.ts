import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const WATCHED = ['src', 'crates', 'static', 'vite.config.ts', 'package.json'];
const IGNORED = new Set(['generated', 'node_modules', 'target', '.svelte-kit']);

async function newestMtime(path: string): Promise<number> {
  const entry = await stat(path);
  if (!entry.isDirectory()) return entry.mtimeMs;

  let newest = 0;
  for (const child of await readdir(path, { withFileTypes: true })) {
    if (IGNORED.has(child.name)) continue;
    newest = Math.max(newest, await newestMtime(join(path, child.name)));
  }
  return newest;
}

export async function assertBundleIsCurrent(): Promise<void> {
  let builtAt: number;
  try {
    builtAt = (await stat('dist/index.html')).mtimeMs;
  } catch {
    throw new Error('No dist/index.html: the app was never built for this run.');
  }

  const sources = await Promise.all(WATCHED.map((path) => newestMtime(path).catch(() => 0)));
  const newestSource = Math.max(...sources);
  if (newestSource <= builtAt) return;

  const age = Math.round((newestSource - builtAt) / 1000);
  throw new Error(
    `dist is ${String(age)}s older than its sources: a preview server left running made Playwright skip the build. Run \`fuser -k 4173/tcp\` and try again.`
  );
}
