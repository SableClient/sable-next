import { expect, test } from 'vitest';

import { pixelatedImage } from './pixelated.js';

test('smart pixelates only images known to be small', () => {
  expect(pixelatedImage('smart', 64, 64)).toBe(true);
  expect(pixelatedImage('smart', 800, 120)).toBe(true);
  expect(pixelatedImage('smart', 192, 192)).toBe(false);
  expect(pixelatedImage('smart', null, 64)).toBe(false);
});

test('always and never ignore the size', () => {
  expect(pixelatedImage('always', 1024, 1024)).toBe(true);
  expect(pixelatedImage('always', null, null)).toBe(true);
  expect(pixelatedImage('never', 16, 16)).toBe(false);
});
