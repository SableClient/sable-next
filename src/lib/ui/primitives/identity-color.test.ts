import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { identityColor } from './identity-color.js';

function channel(value: number): number {
  return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: number[]): number {
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function hslToRgb(hue: number, saturation: number, lightness: number): number[] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const at = (offset: number): number => {
    const k = (offset + hue / 30) % 12;
    return lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [at(0), at(8), at(4)];
}

function parseHsl(color: string): number[] {
  const match = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(color);
  expect(match).not.toBeNull();
  const [, hue, saturation, lightness] = match ?? [];
  return hslToRgb(Number(hue), Number(saturation) / 100, Number(lightness) / 100);
}

function parseHex(color: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255);
}

function contrast(first: number[], second: number[]): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

const styles = readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8');
const onPlate = /--avatar-identity-on-plate: (#[0-9a-f]{6});/.exec(styles)?.[1];

test('the initials colour is declared once, for every theme', () => {
  expect(onPlate).toBeDefined();
  expect(styles.match(/--avatar-identity-on-plate:/g)).toHaveLength(1);
});

test('initials on every identity plate meet 4.5:1', () => {
  const ink = parseHex(onPlate ?? '');
  for (let index = 0; index < 720; index += 1) {
    const plate = parseHsl(identityColor(`@user${index}:example.org`));
    expect(contrast(plate, ink)).toBeGreaterThanOrEqual(4.5);
  }
});
