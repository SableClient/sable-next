#!/usr/bin/env node

// `mise exec` resolves every tool in mise.toml before it runs anything, which
// drags the wasm toolchain into jobs that only need a lockfile install — and
// binaryen has no linux/arm64 build, so the aarch64 runner cannot get past it.
// CI has no use for git hooks anyway.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (process.env.CI) process.exit(0);

const { status } = spawnSync('mise', ['exec', '--', 'lefthook', 'install', '--force'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(status ?? 1);
