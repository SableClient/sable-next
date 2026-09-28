import { describe, expect, it } from 'vitest';

import { applyCustomTheme, applyCustomTweaks, applyQuickCss } from './theme';

describe('applyCustomTweaks', () => {
  const styleIds = (): string[] =>
    [...document.head.querySelectorAll('style[id^="sable-"]')].map((style) => style.id);

  it('keeps tweaks after the theme whichever lands first', () => {
    applyCustomTweaks(['.sable-button { color: red; }']);
    applyCustomTheme('/* @sable-theme */ :root { --primary-main: #fff; }');

    applyQuickCss('.btn { color: blue; }');

    expect(styleIds()).toEqual(['sable-custom-theme', 'sable-custom-tweaks', 'sable-quick-css']);
    expect(document.getElementById('sable-custom-tweaks')?.textContent).toBe(
      '.btn { color: red; }'
    );

    applyCustomTweaks([]);
    applyCustomTheme(undefined);
    applyQuickCss('');
    expect(styleIds()).toEqual([]);
  });
});
