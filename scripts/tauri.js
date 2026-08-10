#!/usr/bin/env node
//MISE description="Run Tauri CLI"
//MISE depends="tauri:setup"
//MISE raw_args=true

import { run } from '@tauri-apps/cli';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(join(__dirname, '..'));

try {
  await run(process.argv.slice(2), 'tauri');
} catch (error) {
  console.error(`[tauri] ${error?.message ?? error}`);
  process.exit(1);
}
