// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import {
  customThemes,
  installCustomTheme,
  installCustomTweak,
  removeCustomTheme,
  removeCustomTweak,
  replaceCustomThemes,
} from './custom-themes.svelte.js';

afterEach(() => {
  replaceCustomThemes({
    themes: [],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  });
  localStorage.clear();
});

test('removing the selected theme falls back to the built-in one', () => {
  installCustomTheme({ id: 'night', name: 'Night', kind: 'dark', css: '/* @sable-theme */' });
  expect(customThemes.darkThemeId).toBe('night');

  removeCustomTheme('night');

  expect(customThemes.themes).toEqual([]);
  expect(customThemes.darkThemeId).toBeNull();
  expect(localStorage.getItem('sable-custom-themes')).not.toContain('night');
});

test('removing a tweak also disables it', () => {
  installCustomTweak({ id: 'round', name: 'Round', css: '/* @sable-tweak */' });
  expect(customThemes.enabledTweakIds).toEqual(['round']);

  removeCustomTweak('round');

  expect(customThemes.tweaks).toEqual([]);
  expect(customThemes.enabledTweakIds).toEqual([]);
});
