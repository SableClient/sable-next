import { expect, test } from 'vitest';

import { clampPan } from './pan-clamp.js';

test('centers content that fits inside the container', () => {
  expect(
    clampPan({ x: 40, y: -40 }, { width: 800, height: 600 }, { width: 400, height: 300 })
  ).toEqual({ x: 0, y: 0 });
});

test('allows panning up to half the overflow on each axis', () => {
  const result = clampPan(
    { x: 1000, y: -1000 },
    { width: 800, height: 600 },
    { width: 1600, height: 900 }
  );
  expect(result).toEqual({ x: 400, y: -150 });
});

test('leaves an in-range pan untouched', () => {
  const result = clampPan(
    { x: 100, y: -50 },
    { width: 800, height: 600 },
    { width: 1600, height: 900 }
  );
  expect(result).toEqual({ x: 100, y: -50 });
});
