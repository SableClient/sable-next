// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import {
  MAX_THEME_FILE_BYTES,
  parseThemeFile,
  themeFileBaseName,
  themeFileMetadata,
  themeSwatches,
} from './theme-file';

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

test('reads the catalog header fields and the prefixed colour tokens', () => {
  const css = `/*
@sable-theme
name: Accord
author: kr0nst
kind: dark
contrast: high
tags: dark, calm
*/
.x { --sable-bg-container: #2c2d32; --sable-primary-main: #5865f2; }`;

  expect(themeFileMetadata(css)).toMatchObject({
    name: 'Accord',
    author: 'kr0nst',
    kind: 'dark',
    contrast: 'high',
    tags: ['dark', 'calm'],
  });
  expect(themeSwatches(css)).toEqual(['#2c2d32', '#5865f2']);
});
