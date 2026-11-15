import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { isCroppable } from './croppable';

const fixture = (name: string) =>
  new Blob([readFileSync(`crates/sable-model/tests/fixtures/images/${name}`)]);

test('skips animated images and SVG', async () => {
  for (const name of ['animated.gif', 'animated.webp', 'animated.png', 'animated.avif']) {
    expect(await isCroppable(fixture(name)), name).toBe(false);
  }
  expect(await isCroppable(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>']))).toBe(false);
});

test('crops still images, a one-frame GIF included', async () => {
  for (const name of ['still.gif', 'still.webp', 'still.png', 'still.avif']) {
    expect(await isCroppable(fixture(name)), name).toBe(true);
  }
  expect(await isCroppable(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]))).toBe(true);
});
