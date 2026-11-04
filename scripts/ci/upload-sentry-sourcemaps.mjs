import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SentryCli } from '@sentry/cli';

export async function collectMaps(root) {
  const entries = await readdir(root, { recursive: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter((entry) => entry.endsWith('.map')).map((entry) => join(root, entry));
}

export function sentryCommands(assets, release) {
  return [
    ['sourcemaps', 'inject', assets],
    ['sourcemaps', 'upload', '--release', release, assets],
  ];
}

async function main() {
  if (!process.env.VITE_SENTRY_DSN) return;
  for (const name of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'VITE_APP_VERSION']) {
    if (!process.env[name]) throw new Error(`${name} is required for source map uploads`);
  }
  const [assets = 'dist'] = process.argv.slice(2);
  for (const args of sentryCommands(assets, process.env.VITE_APP_VERSION)) {
    execFileSync(SentryCli.getPath(), args, { stdio: 'inherit' });
  }
  if (process.env.VITE_SENTRY_ENVIRONMENT !== 'production') return;
  for (const root of [assets, '.svelte-kit/output']) {
    for (const map of await collectMaps(root)) await rm(map);
  }
}

if (import.meta.main) await main();
