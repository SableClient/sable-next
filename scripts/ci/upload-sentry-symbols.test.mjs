import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectSymbols } from './upload-sentry-symbols.mjs';

test('finds app symbols and excludes dependencies and bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
  try {
    const files = [
      'release/app',
      'release/app.pdb',
      'aarch64-linux-android/release/libapp_lib.so',
      'release/deps/libdependency.so',
      'release/bundle/app',
      'debug/app',
      'build/archive/Sable.app.dSYM/Contents/Resources/DWARF/Sable',
      'build/archive/Sentry.framework.dSYM/Contents/Resources/DWARF/Sentry',
    ];
    for (const file of files) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), 'fixture');
    }
    assert.deepEqual((await collectSymbols(root)).map((path) => relative(root, path)).sort(), [
      'aarch64-linux-android/release/libapp_lib.so',
      'build/archive/Sable.app.dSYM',
      'release/app',
      'release/app.pdb',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails when a symbol directory cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
  try {
    await assert.rejects(collectSymbols(join(root, 'missing')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'validates debug data and requires every build output',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
    try {
      const release = join(root, 'release');
      const source = join(root, 'main.c');
      const binary = join(release, 'app');
      await mkdir(release);
      await writeFile(source, 'int main(void) { return 0; }');
      execFileSync('cc', ['-g', '-Wl,--build-id', source, '-o', binary]);
      const script = fileURLToPath(new URL('./upload-sentry-symbols.mjs', import.meta.url));
      const validate = (...paths) =>
        execFileSync(process.execPath, [script, '--dry-run', ...paths], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            VITE_SENTRY_DSN: 'https://public@example.invalid/1',
            SENTRY_AUTH_TOKEN: '',
            SENTRY_ORG: '',
            SENTRY_PROJECT: '',
            SENTRY_URL: 'http://127.0.0.1:1',
          },
        });
      assert.match(validate(release), /Validated 1 debug identifiers/);
      const missingAbi = join(root, 'armv7', 'release');
      await mkdir(missingAbi, { recursive: true });
      assert.throws(() => validate(release, missingAbi), /No native symbols found/);
      assert.throws(() => validate('--ios', release), /Missing iOS app dSYM/);
      execFileSync('strip', ['--strip-debug', binary]);
      assert.throws(() => validate(release), /Missing usable debug information/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
