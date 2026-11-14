import { expect, test } from 'vitest';

import { isCroppable } from './croppable';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, length = 0): number[] {
  return [0, 0, 0, length, ...ascii(type), ...Array<number>(length + 4).fill(0)];
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function webp(flags: number): number[] {
  const header = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0];
  return [...header, flags, 0, 0, 0];
}

const blob = (bytes: number[]) => new Blob([new Uint8Array(bytes)]);

test('skips GIFs, animated WebP, APNG and SVG', async () => {
  expect(await isCroppable(blob([...ascii('GIF89a'), 0, 0]))).toBe(false);
  expect(await isCroppable(blob(webp(0x02)))).toBe(false);
  expect(await isCroppable(blob(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe(false);
  expect(
    await isCroppable(blob([...PNG, ...chunk('IHDR', 13), ...chunk('acTL', 8), ...chunk('IDAT')]))
  ).toBe(false);
});

test('crops still images', async () => {
  expect(await isCroppable(blob(webp(0x10)))).toBe(true);
  expect(
    await isCroppable(blob([...PNG, ...chunk('IHDR', 13), ...chunk('IDAT'), ...chunk('acTL', 8)]))
  ).toBe(true);
  expect(await isCroppable(blob([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
});
