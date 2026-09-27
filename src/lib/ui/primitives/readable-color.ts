import { preferences, type NameColorCorrection } from '#lib/settings/preferences.svelte.js';

type Rgb = [number, number, number];
type Lab = [number, number, number];

export const WHITE = '#ffffff';
export const BLACK = '#000000';
const LIGHT_GROUND = '#e4e4e7';
const DARK_GROUND = '#2d2c36';
const TEXT_RATIO = 4.5;
const WEAK_TEXT_RATIO = 3;

const adjusted = new Map<string, string>();

function parseHex(hex: string): Rgb | null {
  const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].replaceAll(/./g, '$&$&') : match[1];
  return [0, 2, 4].map(
    (offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255
  ) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

function rounded(rgb: Rgb): Rgb {
  return rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255) / 255) as Rgb;
}

function toLinear(channel: number): number {
  return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  return channel <= 0.003_130_8 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map(toLinear);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function ratio(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function toOklab(rgb: Rgb): Lab {
  const [red, green, blue] = rgb.map(toLinear);
  const l = Math.cbrt(0.412_221_470_8 * red + 0.536_332_536_3 * green + 0.051_445_992_9 * blue);
  const m = Math.cbrt(0.211_903_498_2 * red + 0.680_699_545_1 * green + 0.107_396_956_6 * blue);
  const s = Math.cbrt(0.088_302_461_9 * red + 0.281_718_837_6 * green + 0.629_978_700_5 * blue);
  return [
    0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
    1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
    0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
  ];
}

function fromOklab([lightness, a, b]: Lab): Rgb {
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  return [
    4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
    -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
    -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
  ].map(fromLinear) as Rgb;
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

export interface ProfilePalette {
  ground: string;
  panel: string;
  muted: string;
}

export function profilePalette(hero: string, ink: string): ProfilePalette | null {
  const inkRgb = parseHex(ink);
  const rgb = parseHex(hero);
  if (!rgb || !inkRgb) return null;
  const inkLab = toOklab(inkRgb);
  const derive = (ground: Rgb): [Rgb, Rgb] => {
    const lab = toOklab(ground);
    return [rounded(fromOklab(mix(lab, inkLab, 0.12))), rounded(fromOklab(mix(lab, inkLab, 0.75)))];
  };
  const ground = shift(rgb, inkFor(ink) === WHITE, (candidate) => {
    const [panel, muted] = derive(candidate);
    return [
      ratio(inkRgb, candidate),
      ratio(inkRgb, panel),
      ratio(muted, candidate),
      ratio(muted, panel),
    ].every((value) => value >= TEXT_RATIO);
  });
  const [panel, muted] = derive(ground);
  return { ground: toHex(ground), panel: toHex(panel), muted: toHex(muted) };
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
