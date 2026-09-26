import { expect, test } from 'vitest';

import { formatClockDuration } from './clock-duration.js';

test('formats whole seconds as m:ss', () => {
  expect(formatClockDuration(0)).toBe('0:00');
  expect(formatClockDuration(7)).toBe('0:07');
  expect(formatClockDuration(65)).toBe('1:05');
  expect(formatClockDuration(600)).toBe('10:00');
});

test('an hour or more gains an hours field', () => {
  expect(formatClockDuration(3725)).toBe('1:02:05');
});
