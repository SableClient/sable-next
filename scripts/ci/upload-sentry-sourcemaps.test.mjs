import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { collectMaps, sentryCommands } from './upload-sentry-sourcemaps.mjs';

test('finds nested maps and tolerates a missing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sable-maps-'));
  try {
    for (const file of ['a.js', 'a.js.map', '_app/immutable/chunks/b.js.map', 'c.css']) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), 'fixture');
    }
    assert.deepEqual((await collectMaps(root)).map((path) => relative(root, path)).sort(), [
      '_app/immutable/chunks/b.js.map',
      'a.js.map',
    ]);
    assert.deepEqual(await collectMaps(join(root, 'missing')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('injects debug ids before uploading source maps', () => {
  assert.deepEqual(sentryCommands('electron/dist', 'v1'), [
    ['sourcemaps', 'inject', 'electron/dist'],
    ['sourcemaps', 'upload', '--release', 'v1', 'electron/dist'],
  ]);
});
