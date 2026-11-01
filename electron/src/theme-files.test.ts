import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { readThemeFile } from './theme-files';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sable-theme-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('reads a theme only when it changed', async () => {
  const path = join(directory, 'matugen.sable.css');
  await writeFile(path, '/* @sable-theme */');

  const first = await readThemeFile(path, null);
  expect(first?.css).toBe('/* @sable-theme */');
  expect(await readThemeFile(path, first?.modified ?? 0)).toBeNull();
  expect(await readThemeFile(path, (first?.modified ?? 0) - 1)).not.toBeNull();
});

test('refuses files that are not css or over the theme limit', async () => {
  const json = join(directory, 'secrets.json');
  const huge = join(directory, 'huge.css');
  await writeFile(json, '{}');
  await writeFile(huge, ' '.repeat(1024 * 1024 + 1));

  await expect(readThemeFile(json, null)).rejects.toThrow('Not a .css file');
  await expect(readThemeFile(huge, null)).rejects.toThrow('Theme file too large');
});
