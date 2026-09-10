import { describe, expect, it } from 'vitest';

import { renameLegacyThemeIdentifiers, resolveTheme } from './theme';

describe('resolveTheme', () => {
  it.each([
    ['system', false, 'light'],
    ['system', true, 'dark'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
  ] as const)('resolves %s with system dark %s as %s', (mode, systemPrefersDark, expected) => {
    expect(resolveTheme(mode, systemPrefersDark)).toBe(expected);
  });
});

describe('renameLegacyThemeIdentifiers', () => {
  const legacy = '--sable-';

  it.each([
    [`${legacy}primary-main: #fff;`, '--primary-main: #fff;'],
    [`color: var(${legacy}surface-on-container);`, 'color: var(--surface-on-container);'],
    [`${legacy}shadow: rgb(0 0 0 / 10%);`, '--shadow-color: rgb(0 0 0 / 10%);'],
    ['.sable-menu-item { color: red; }', '.menu-item { color: red; }'],
    ['.sable-button { color: red; }', '.btn { color: red; }'],
    ['.sable-button-primary { color: red; }', '.btn-primary { color: red; }'],
    ['.sable-avatar { color: red; }', '.avatar-root { color: red; }'],
    ['.sable-avatar-fallback { color: red; }', '.avatar-fallback { color: red; }'],
    ['.sable-menu { color: red; }', '.menu-surface { color: red; }'],
    [
      '.sable-open[data-state="open"] { color: red; }',
      '.selection-open[data-state="open"] { color: red; }',
    ],
    ['.sable-switch-thumb { color: red; }', '.switch-thumb { color: red; }'],
    ['.sable-progress { color: red; }', '.progress-track { color: red; }'],
  ])('rewrites %s', (legacy, expected) => {
    expect(renameLegacyThemeIdentifiers(legacy)).toBe(expected);
  });

  it('leaves the theme marker and current names alone', () => {
    const css = '/* @sable-theme */ :root { --primary-main: #fff; } .btn { color: red; }';
    expect(renameLegacyThemeIdentifiers(css)).toBe(css);
  });
});
