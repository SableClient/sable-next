import {
  convertOklabToRgb,
  convertRgbToOklab,
  parseHex as parseColorHex,
  serializeHex,
  wcagContrast,
} from 'culori/fn';
import type { Rgb as ColorRgb } from 'culori';

import '#lib/culori.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { type NameColorCorrection } from '#lib/settings/definitions.js';

type Rgb = [number, number, number];
type Lab = [number, number, number];

export const WHITE = '#ffffff';
export const BLACK = '#000000';
const LIGHT_GROUND = '#e4e4e7';
const DARK_GROUND = '#2d2c36';
const TEXT_RATIO = 4.5;
const WEAK_TEXT_RATIO = 3;

const adjusted = new Map<string, string>();

function colorRgb([r, g, b]: Rgb): ColorRgb {
  return { mode: 'rgb', r, g, b };
}

function parseHex(hex: string): Rgb | null {
  const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const color = parseColorHex(`#${match[1]}`);
  return color ? [color.r, color.g, color.b] : null;
}

function toHex(rgb: Rgb): string {
  return serializeHex(colorRgb(rgb));
}

function rounded(rgb: Rgb): Rgb {
  return rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255) / 255) as Rgb;
}

function ratio(first: Rgb, second: Rgb): number {
  return wcagContrast(colorRgb(first), colorRgb(second));
}

function toOklab(rgb: Rgb): Lab {
  const { l, a, b } = convertRgbToOklab(colorRgb(rgb));
  return [l, a, b];
}

function fromOklab([l, a, b]: Lab): Rgb {
  const { r, g, b: blue } = convertOklabToRgb({ l, a, b });
  return [r, g, blue];
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

function atLightness([, a, b]: Lab, lightness: number): Rgb {
  let low = 0;
  let high = 1;
  if (inGamut(fromOklab([lightness, a, b]))) return fromOklab([lightness, a, b]);
  for (let step = 0; step < 24; step += 1) {
    const scale = (low + high) / 2;
    if (inGamut(fromOklab([lightness, a * scale, b * scale]))) low = scale;
    else high = scale;
  }
  return fromOklab([lightness, a * low, b * low]);
}

export function contrastRatio(first: string, second: string): number {
  const a = parseHex(first);
  const b = parseHex(second);
  return a && b ? ratio(a, b) : 1;
}

export function inkFor(ground: string): string {
  return contrastRatio(ground, WHITE) >= contrastRatio(ground, BLACK) ? WHITE : BLACK;
}

function readableAgainst(color: string, against: string, minimum: number): string {
  const key = `${color}|${against}|${minimum}`;
  const cached = adjusted.get(key);
  if (cached !== undefined) return cached;
  const result = separate(color, against, minimum);
  adjusted.set(key, result);
  return result;
}

const NAME_RATIOS: Record<NameColorCorrection, number | null> = {
  strong: TEXT_RATIO,
  weak: WEAK_TEXT_RATIO,
  off: null,
};

function nameColorAgainst(color: string | null | undefined, ground: string): string | null {
  if (!color) return null;
  const ratio = NAME_RATIOS[preferences.nameColorCorrection];
  return ratio === null ? color : readableAgainst(color, ground, ratio);
}

export function nameColorOnLight(color: string | null | undefined): string | null {
  return nameColorAgainst(color, LIGHT_GROUND);
}

export function nameColorOnDark(color: string | null | undefined): string | null {
  return nameColorAgainst(color, DARK_GROUND);
}

/** A role tag is the room's colour, so it is always corrected. */
export function roleColorOnLight(color: string | null | undefined): string | null {
  return color ? readableAgainst(color, LIGHT_GROUND, TEXT_RATIO) : null;
}

export function roleColorOnDark(color: string | null | undefined): string | null {
  return color ? readableAgainst(color, DARK_GROUND, TEXT_RATIO) : null;
}

export interface ProfilePalette {
  ground: string;
  panel: string;
  muted: string;
}

export function profilePalette(hero: string, ink: string): ProfilePalette | null {
  const rgb = parseHex(hero);
  if (!rgb || !parseHex(ink)) return null;
  const ground = toOklab(rgb);
  const opposite = parseHex(inkFor(ink));
  if (!opposite) return null;
  const oppositeInk = toOklab(opposite);
  const panel = rounded(fromOklab(mix(ground, oppositeInk, 0.08)));
  return { ground: hero, panel: toHex(panel), muted: ink };
}

export function nameColorOn(color: string, ground: string): string {
  return readableAgainst(color, ground, TEXT_RATIO);
}

function mix(from: Lab, to: Lab, amount: number): Lab {
  return from.map((value, index) => value + (to[index] - value) * amount) as Lab;
}

function separate(color: string, against: string, minimum: number): string {
  const rgb = parseHex(color);
  const reference = parseHex(against);
  if (!rgb || !reference) return color;
  return toHex(
    shift(rgb, inkFor(against) === WHITE, (candidate) => ratio(candidate, reference) >= minimum)
  );
}

function shift(rgb: Rgb, lighten: boolean, passes: (candidate: Rgb) => boolean): Rgb {
  if (passes(rgb)) return rgb;
  const lab = toOklab(rgb);
  let near = lab[0];
  let far = lighten ? 1 : 0;
  for (let step = 0; step < 24; step += 1) {
    const lightness = (near + far) / 2;
    if (passes(rounded(atLightness(lab, lightness)))) far = lightness;
    else near = lightness;
  }
  return rounded(atLightness(lab, far));
}
