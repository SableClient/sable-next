import { expect, test } from 'vitest';

import { MAX_THEME_FILE_BYTES, parseThemeFile, themeFileBaseName } from './theme-file';

test('reads a theme header for its name and kind', () => {
  const parsed = parseThemeFile('/*\n@sable-theme\nname: Night\nkind: dark\n*/', 'fallback');

  expect(parsed).toMatchObject({ kind: 'theme', theme: { name: 'Night', kind: 'dark' } });
});

test('a tweak falls back to the file name', () => {
  const parsed = parseThemeFile('/* @sable-tweak */ .x {}', themeFileBaseName('round.sable.css'));

  expect(parsed).toMatchObject({ kind: 'tweak', tweak: { name: 'round' } });
});

test('refuses a file without a header or over the size limit', () => {
  expect(parseThemeFile('.x {}', 'plain')).toBe('header');
  expect(parseThemeFile('/* @sable-theme */'.padEnd(MAX_THEME_FILE_BYTES + 1), 'big')).toBe('size');
});
