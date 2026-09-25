import jsQR from 'jsqr';
import { expect, test } from 'vitest';

import fixture from './verification-qr.fixture.json';
import { qrLayout } from './verification-qr';

const SCALE = 6;

function rasterise(logo: boolean): { data: Uint8ClampedArray; side: number } {
  const layout = qrLayout(fixture.code);
  const side = layout.size * SCALE;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  const paint = (px: number, py: number) => {
    const offset = (py * side + px) * 4;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
  };
  for (const [x, y] of layout.dark) {
    for (let dy = 0; dy < SCALE; dy += 1) {
      for (let dx = 0; dx < SCALE; dx += 1) paint(x * SCALE + dx, y * SCALE + dy);
    }
  }
  if (logo) {
    const centre = layout.plate.centre * SCALE;
    const radius = (layout.logo.size / 2) * SCALE;
    for (let py = 0; py < side; py += 1) {
      for (let px = 0; px < side; px += 1) {
        if (Math.hypot(px + 0.5 - centre, py + 0.5 - centre) < radius) paint(px, py);
      }
    }
  }
  return { data, side };
}

test('the code still decodes to its exact bytes with the logo over its centre', () => {
  const { data, side } = rasterise(true);
  const decoded = jsQR(data, side, side, { inversionAttempts: 'dontInvert' });

  expect(decoded?.binaryData).toEqual(fixture.payload);
});

test('the logo stays within what level H can recover and clear of the finder patterns', () => {
  const layout = qrLayout(fixture.code);
  const covered = Math.PI * layout.plate.radius ** 2;
  const finderEnd = 4 + 7;

  expect(covered / fixture.code.width ** 2).toBeLessThan(0.08);
  expect(layout.plate.centre - layout.plate.radius).toBeGreaterThan(finderEnd);
});
