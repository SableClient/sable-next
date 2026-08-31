import { expect, test } from 'vitest';

import { plateColor } from './dominant-color.js';

function pixels(...colors: readonly [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flat());
}

function channels(color: string): [number, number, number] {
  const parsed = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
  expect(parsed).not.toBeNull();
  return [Number(parsed?.[1]), Number(parsed?.[2]), Number(parsed?.[3])];
}

test('a fully transparent sample has no plate', () => {
  expect(plateColor(pixels([255, 0, 0, 0], [0, 255, 0, 8]))).toBeNull();
  expect(plateColor(new Uint8ClampedArray())).toBeNull();
});

test('the plate keeps the dominant hue and comes back darker', () => {
  const color = plateColor(
    pixels([200, 40, 40, 255], [200, 40, 40, 255], [200, 40, 40, 255], [40, 40, 200, 255])
  );

  expect(color).not.toBeNull();
  const [red, green, blue] = channels(color ?? '');
  expect(red).toBeGreaterThan(green);
  expect(red).toBeGreaterThan(blue);
  expect(red).toBeLessThan(200);
});

test('chroma outweighs a bare majority of grey', () => {
  const grey: [number, number, number, number] = [128, 128, 128, 255];
  const color = plateColor(pixels(grey, grey, [20, 180, 220, 255], [20, 180, 220, 255]));

  const [red, green, blue] = channels(color ?? '');
  expect(blue).toBeGreaterThan(red);
  expect(green).toBeGreaterThan(red);
});
