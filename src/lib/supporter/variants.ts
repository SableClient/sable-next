import type { ProfileFieldView } from '#src/generated/protocol';
import { isRecord } from '#lib/guards.js';
import { SUPPORTER_BADGE_FIELD } from '#lib/profile/fields.js';
import { inkFor, WHITE } from '#lib/ui/primitives/readable-color.js';

export const SUPPORTER_VARIANTS = [
  'gold',
  'custom',
  'propeller',
  'ghost',
  'evil',
  'agender',
  'agendergradient',
  'bisexual',
  'bisexualgradient',
  'pansexual',
  'pansexualgradient',
  'trans',
  'transgradient',
  'intersex',
  'intersexgradient',
  'lesbian',
  'lesbiangradient',
  'mlm',
  'mlmgradient',
  'pride',
  'pridegradient',
  'ceo',
] as const;
export type SupporterVariant = (typeof SUPPORTER_VARIANTS)[number];
export const SUPPORTER_SHAPES = ['none', 'circle', 'heart', 'square'] as const;
export type SupporterShape = (typeof SUPPORTER_SHAPES)[number];
export const MAX_SUPPORTER_GRADIENT_COLORS = 5;
export const DEFAULT_GRADIENT_ANGLE = 90;

export type SupporterAppearance = {
  variant: SupporterVariant;
  shape: SupporterShape;
  customBackground: boolean;
  backgroundColor: string;
  color: string;
  colors?: string[];
  gradientAngle?: number;
  customCardColors: boolean;
  cardColor: string;
  buttonColor: string;
};
export const DEFAULT_SUPPORTER_COLOR = '#9987f7';
export const DEFAULT_SUPPORTER_CARD_COLOR = '#24212e';
export const DEFAULT_SUPPORTER_BUTTON_COLOR = '#e8c783';
export const DEFAULT_SUPPORTER_BACKGROUND_COLOR = '#24212e';
export const DEFAULT_SUPPORTER_GRADIENT_COLOR = '#21b1ff';

export function isSupporterColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

export function isSupporterColors(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= MAX_SUPPORTER_GRADIENT_COLORS &&
    value.every(isSupporterColor)
  );
}

export function supporterColor(value: unknown, fallback = DEFAULT_SUPPORTER_COLOR): string {
  if (!isSupporterColor(value)) return fallback;
  const hex = value.slice(1).toLowerCase();
  return `#${hex.length === 3 ? hex.replaceAll(/./g, '$&$&') : hex}`;
}

export function supporterGradientAngle(value: unknown, fallback = DEFAULT_GRADIENT_ANGLE): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return ((Math.round(value) % 360) + 360) % 360;
}

export function supporterButtonText(value: unknown): string {
  return inkFor(supporterColor(value)) === WHITE
    ? 'var(--supporter-white)'
    : 'var(--supporter-black)';
}

export function supporterVariant(value: unknown): SupporterVariant {
  return typeof value === 'string' && SUPPORTER_VARIANTS.includes(value as SupporterVariant)
    ? (value as SupporterVariant)
    : 'gold';
}

export function profileSupporterAppearance(fields: ProfileFieldView[] = []): SupporterAppearance {
  const raw = fields.find((field) => field.key === SUPPORTER_BADGE_FIELD)?.value;
  let value: unknown;
  try {
    value = JSON.parse(raw ?? 'null');
  } catch {
    value = null;
  }
  return supporterAppearance(value);
}

export function supporterAppearance(value: unknown = null): SupporterAppearance {
  const appearance = isRecord(value) ? value : {};
  const validColors = Array.isArray(appearance.colors)
    ? appearance.colors
        .filter(isSupporterColor)
        .slice(0, MAX_SUPPORTER_GRADIENT_COLORS)
        .map((c) => supporterColor(c))
    : [];
  const colors = isSupporterColors(validColors) ? validColors : undefined;
  const gradientAngle =
    typeof appearance.gradientAngle === 'number' && Number.isFinite(appearance.gradientAngle)
      ? supporterGradientAngle(appearance.gradientAngle)
      : undefined;

  return {
    variant: supporterVariant(appearance.variant),
    shape: SUPPORTER_SHAPES.includes(appearance.shape as SupporterShape)
      ? (appearance.shape as SupporterShape)
      : 'circle',
    customBackground: appearance.customBackground === true,
    backgroundColor: supporterColor(appearance.backgroundColor, DEFAULT_SUPPORTER_BACKGROUND_COLOR),
    color: supporterColor(appearance.color, colors ? colors[0] : DEFAULT_SUPPORTER_COLOR),
    ...(colors ? { colors } : {}),
    ...(gradientAngle !== undefined ? { gradientAngle } : {}),
    customCardColors: appearance.customCardColors === true,
    cardColor: supporterColor(appearance.cardColor, DEFAULT_SUPPORTER_CARD_COLOR),
    buttonColor: supporterColor(appearance.buttonColor, DEFAULT_SUPPORTER_BUTTON_COLOR),
  };
}
