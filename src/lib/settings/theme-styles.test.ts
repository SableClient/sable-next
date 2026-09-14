import { describe, expect, it } from 'vitest';

import { applyCustomTheme, applyCustomTweaks } from './theme';

describe('applyCustomTweaks', () => {
  const styleIds = (): string[] =>
    [...document.head.querySelectorAll('style[id^="sable-custom"]')].map((style) => style.id);

  it('keeps tweaks after the theme whichever lands first', () => {
    applyCustomTweaks(['.sable-button { color: red; }']);
    applyCustomTheme('/* @sable-theme */ :root { --primary-main: #fff; }');

    expect(styleIds()).toEqual(['sable-custom-theme', 'sable-custom-tweaks']);
    expect(document.getElementById('sable-custom-tweaks')?.textContent).toBe(
      '.btn { color: red; }'
    );

    applyCustomTweaks([]);
    applyCustomTheme(undefined);
    expect(styleIds()).toEqual([]);
  });
});
