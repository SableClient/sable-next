import { expect, test } from 'vitest';

import { pixelatedImage } from './pixelated.js';

test('smart pixelates only images known to be small', () => {
  expect(pixelatedImage('smart', 64, 64)).toBe(true);
  expect(pixelatedImage('smart', 800, 120)).toBe(true);
  expect(pixelatedImage('smart', 192, 192)).toBe(false);
  expect(pixelatedImage('smart', null, 64)).toBe(false);
});

test('smart leaves an image alone unless it is drawn larger than its pixels', () => {
  expect(pixelatedImage('smart', 64, 64, { width: 32, height: 32 })).toBe(false);
  expect(pixelatedImage('smart', 64, 64, { width: 64, height: 64 })).toBe(false);
  expect(pixelatedImage('smart', 64, 64, { width: 96, height: 96 })).toBe(true);
  expect(pixelatedImage('smart', 64, 64, { width: 0, height: 0 })).toBe(true);
});

test('always and never ignore the size', () => {
  expect(pixelatedImage('always', 1024, 1024)).toBe(true);
  expect(pixelatedImage('always', null, null)).toBe(true);
  expect(pixelatedImage('never', 16, 16)).toBe(false);
});
