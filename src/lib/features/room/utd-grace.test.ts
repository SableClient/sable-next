import { expect, test } from 'vitest';

import { UTD_GRACE_MS, utdGraceRemaining } from './utd-grace';

test('a freshly seen item gets the whole grace period', () => {
  expect(utdGraceRemaining('$fresh', 1000)).toBe(UTD_GRACE_MS);
});

test('scrolling a row back into view does not restart its grace', () => {
  utdGraceRemaining('$scrolled', 1000);
  expect(utdGraceRemaining('$scrolled', 1000 + UTD_GRACE_MS)).toBe(0);
});

test('the remaining time shrinks with the clock', () => {
  utdGraceRemaining('$shrinking', 1000);
  expect(utdGraceRemaining('$shrinking', 3000)).toBe(UTD_GRACE_MS - 2000);
});
