import { describe, expect, it } from 'vitest';

import { isOverlayHistoryState } from './back-navigation.js';

describe('isOverlayHistoryState', () => {
  it('recognises a history entry pushed for an open overlay', () => {
    expect(isOverlayHistoryState({ sableOverlayBack: true })).toBe(true);
  });

  it('is false for the app route history it sits on top of', () => {
    expect(isOverlayHistoryState({ idx: 3 })).toBe(false);
  });

  it('is false for a missing or non-object state', () => {
    expect(isOverlayHistoryState(null)).toBe(false);
    expect(isOverlayHistoryState(undefined)).toBe(false);
    expect(isOverlayHistoryState('opaque')).toBe(false);
  });
});
