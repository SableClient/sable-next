import { describe, expect, test } from 'vitest';

import {
  editThreshold,
  linearLimit,
  replyThreshold,
  swipeAction,
  swipeOffset,
} from './message-swipe';

const WIDE = 800;

describe('swipeOffset', () => {
  test('a rightward drag never moves the row', () => {
    expect(swipeOffset(40, WIDE, false)).toBe(0);
    expect(swipeOffset(0, WIDE, false)).toBe(0);
  });

  test('tracks the finger one-to-one up to the linear limit', () => {
    expect(swipeOffset(-20, WIDE, false)).toBe(20);
    expect(swipeOffset(-linearLimit(WIDE, false), WIDE, false)).toBe(linearLimit(WIDE, false));
  });

  test('resists past the limit and never exceeds it', () => {
    const limit = linearLimit(WIDE, false);
    const resisted = swipeOffset(-(limit + 60), WIDE, false);

    expect(resisted).toBeGreaterThan(limit);
    expect(resisted).toBeLessThan(limit + 45);
    expect(swipeOffset(-10_000, WIDE, false)).toBeLessThanOrEqual(limit + 45);
  });

  test('a narrow row scales its thresholds down', () => {
    expect(linearLimit(200, false)).toBeLessThan(linearLimit(WIDE, false));
    expect(replyThreshold(100)).toBeLessThan(replyThreshold(WIDE));
  });
});

describe('swipeAction', () => {
  test('arms nothing until the reply threshold', () => {
    expect(swipeAction(-10, WIDE, false)).toBe('none');
    expect(swipeAction(-(replyThreshold(WIDE) + 1), WIDE, false)).toBe('reply');
  });

  test('a rightward drag arms nothing', () => {
    expect(swipeAction(200, WIDE, true)).toBe('none');
  });

  test('arms edit only past the deeper threshold, and only when editable', () => {
    const deep = -(editThreshold(WIDE, true) + 1);

    expect(swipeAction(deep, WIDE, true)).toBe('edit');
    expect(swipeAction(deep, WIDE, false)).toBe('reply');
  });

  test('edit sits well beyond the reply threshold', () => {
    expect(editThreshold(WIDE, true)).toBeGreaterThan(replyThreshold(WIDE) * 2);
  });
});
