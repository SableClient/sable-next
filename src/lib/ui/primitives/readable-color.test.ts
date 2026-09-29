import { expect, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import {
  BLACK,
  WHITE,
  contrastRatio,
  inkFor,
  nameColorOn,
  nameColorOnDark,
  nameColorOnLight,
  profilePalette,
} from './readable-color.js';

function hsl(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const at = (offset: number): string => {
    const k = (offset + hue / 30) % 12;
    const value = lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${at(0)}${at(8)}${at(4)}`;
}

const SWEEP = Array.from({ length: 36 }, (_, index) => index * 10).flatMap((hue) =>
  [0.5, 1].flatMap((saturation) =>
    [0.1, 0.3, 0.5, 0.7, 0.9].map((lightness) => hsl(hue, saturation, lightness))
  )
);

test('a colour that already passes is returned unchanged', () => {
  expect(nameColorOn('#1b1b3a', WHITE)).toBe('#1b1b3a');
  expect(nameColorOn('#F4E7C8', BLACK)).toBe('#f4e7c8');
  expect(profilePalette('#1b1b3a', WHITE)?.ground).toBe('#1b1b3a');
  expect(profilePalette('#f4e7c8', BLACK)?.ground).toBe('#f4e7c8');
  expect(nameColorOnLight('#2f5a1f')).toBe('#2f5a1f');
  expect(nameColorOnDark('#9fd07c')).toBe('#9fd07c');
});

test('profile palettes preserve the chosen background colour', () => {
  expect(profilePalette('#460333', WHITE)?.ground).toBe('#460333');
  expect(profilePalette('#ff0000', BLACK)?.ground).toBe('#ff0000');
});

test('every hue uses readable ink on the hero and panel', () => {
  for (const color of SWEEP) {
    const ink = inkFor(color);
    const palette = profilePalette(color, ink);
    if (!palette) throw new Error(`no palette for ${color}`);
    for (const ground of [palette.ground, palette.panel]) {
      expect(contrastRatio(ink, ground)).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('the ink is whichever of black and white contrasts more', () => {
  expect(inkFor('#ff0000')).toBe(BLACK);
  expect(inkFor('#1b1b3a')).toBe(WHITE);
});

test('name colours reach 4.5:1 on the theme grounds', () => {
  for (const color of SWEEP) {
    expect(contrastRatio(nameColorOnLight(color) ?? '', '#e4e4e7')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(nameColorOnDark(color) ?? '', '#2d2c36')).toBeGreaterThanOrEqual(4.5);
  }
  expect(nameColorOnLight(null)).toBeNull();
});

test('an unparseable colour is left alone', () => {
  expect(nameColorOn('var(--sec-main)', WHITE)).toBe('var(--sec-main)');
  expect(profilePalette('var(--sec-main)', WHITE)).toBeNull();
});

test('name colour correction can be weakened or turned off', () => {
  const pale = '#fff2a8';
  try {
    preferences.nameColorCorrection = 'off';
    expect(nameColorOnLight(pale)).toBe(pale);

    preferences.nameColorCorrection = 'weak';
    const weak = nameColorOnLight(pale);
    preferences.nameColorCorrection = 'strong';
    const strong = nameColorOnLight(pale);

    expect(weak).not.toBe(pale);
    expect(weak).not.toBe(strong);
  } finally {
    preferences.nameColorCorrection = 'strong';
  }
});
