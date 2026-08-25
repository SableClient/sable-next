#!/usr/bin/env node
//MISE description="Run Tauri CLI"
//MISE depends="tauri:setup"
//MISE raw_args=true

/**
 * Passes through to the Tauri CLI, except that a leading `wry` or `cef` before
 * `dev` or `build` selects the desktop runtime:
 *
 *   node scripts/tauri.js cef build
 *     -> tauri build --no-bundle --features cef -- --no-default-features
 */

import { run } from '@tauri-apps/cli';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(join(__dirname, '..'));

const RUNTIMES = new Set(['wry', 'cef']);

function resolveArgs(argv) {
  const [runtime, command, ...rest] = argv;
  if (!RUNTIMES.has(runtime) || !['dev', 'build'].includes(command)) return argv;

  const args = [command];
  if (runtime === 'cef' && command === 'build' && !rest.includes('--no-bundle')) {
    args.push('--no-bundle');
  }
  args.push('--features', runtime, ...rest);
  // Everything after `--` reaches cargo, which is where the features live.
  if (!rest.includes('--')) args.push('--');
  args.push('--no-default-features');
  return args;
}

try {
  await run(resolveArgs(process.argv.slice(2)), 'tauri');
} catch (error) {
  console.error(`[tauri] ${error?.message ?? error}`);
  process.exit(1);
}
