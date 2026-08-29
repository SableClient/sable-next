import { describe, expect, it } from 'vitest';

import { needsAndroidHistoryRoot } from './android-back.js';

describe('needsAndroidHistoryRoot', () => {
  it('is true for a fresh deep-link launch with no history', () => {
    expect(needsAndroidHistoryRoot(1, undefined)).toBe(true);
  });

  it('is false once the app already built up its own history', () => {
    expect(needsAndroidHistoryRoot(3, undefined)).toBe(false);
  });

  it('is false once the root has already been seeded', () => {
    expect(needsAndroidHistoryRoot(1, 1)).toBe(false);
  });
});
