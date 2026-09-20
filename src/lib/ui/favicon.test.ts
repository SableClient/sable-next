import { describe, expect, test } from 'vitest';

import { faviconState } from './favicon';

describe('faviconState', () => {
  test('a mention wins over an ordinary unread', () => {
    expect(faviconState(true, true, false)).toBe('highlight');
    expect(faviconState(true, true, true)).toBe('highlight');
  });

  test('mentions only leaves an ordinary unread unbadged', () => {
    expect(faviconState(true, false, true)).toBe('idle');
    expect(faviconState(true, false, false)).toBe('unread');
  });

  test('nothing unread is idle either way', () => {
    expect(faviconState(false, false, false)).toBe('idle');
    expect(faviconState(false, false, true)).toBe('idle');
  });
});
