import { describe, expect, it } from 'vitest';

import { resolveTheme } from './theme';

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
