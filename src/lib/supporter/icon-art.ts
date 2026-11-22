import logo from '#lib/assets/res/svg/logo.svg?raw';
import ghost from './ghost.svg?raw';
import agender from '#lib/supporter/app-icons/agender.svg?raw';
import bisexual from '#lib/supporter/app-icons/bisexual.svg?raw';
import pansexual from '#lib/supporter/app-icons/pansexual.svg?raw';
import transgradient from '#lib/supporter/app-icons/transgradient.svg?raw';
import intersex from '#lib/supporter/app-icons/intersex.svg?raw';
import lesbian from '#lib/supporter/app-icons/lesbian.svg?raw';
import mlm from '#lib/supporter/app-icons/mlm.svg?raw';
import pride from '#lib/supporter/app-icons/pride.svg?raw';
import ukraine from '#lib/supporter/app-icons/ukraine.svg?raw';
import palestine from '#lib/supporter/app-icons/palestine.svg?raw';
import cuba from '#lib/supporter/app-icons/cuba.svg?raw';

function flagIconPaths(svg: string) {
  const flag = /<g id="flag"[^>]*>([\s\S]*?)<\/g>/.exec(svg)?.[1];
  if (!flag) throw new Error('Missing flag group in app icon');
  return [...flag.matchAll(/<path fill="([^"]+)" d="([^"]+)"\s*\/>/g)].map(([, fill, d]) => ({
    fill,
    d,
  }));
}

export const FLAG_ICON_PATHS: Partial<Record<string, Array<{ fill: string; d: string }>>> = {
  ukraine: flagIconPaths(ukraine),
  palestine: flagIconPaths(palestine),
  cuba: flagIconPaths(cuba),
};

export const SABLE_PATHS = [...logo.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]);
export const GHOST_SABLE_PATH = /\bd="([^"]+)"/.exec(ghost)?.[1] ?? SABLE_PATHS[0];
export const SABLE_EYE_PATH = SABLE_PATHS[0].slice(SABLE_PATHS[0].lastIndexOf(' M ') + 1);

export const PAW_PATH =
  'M91.669 166.322A43 58 -27 1 0 144.331 269.678A43 58 -27 1 0 91.669 166.322Z M195.457 84.751A43 61 -9 1 0 214.543 205.249A43 61 -9 1 0 195.457 84.751Z M320.543 84.751A43 61 9 1 0 301.457 205.249A43 61 9 1 0 320.543 84.751Z M424.331 166.322A43 58 27 1 0 371.669 269.678A43 58 27 1 0 424.331 166.322Z M256 249C211 247 197 280 167 307C129 341 137 387 177 400C206 410 228 389 256 389C284 389 308 410 338 400C379 386 384 341 347 307C315 279 302 248 256 249Z';

const APP_ICON_SVGS = {
  agender,
  bisexual,
  pansexual,
  transgradient,
  intersex,
  lesbian,
  mlm,
  pride,
};

const APP_ICON_PALETTE_COLORS: Record<keyof typeof APP_ICON_SVGS, string[]> = {
  agender: [
    'var(--supporter-black)',
    'var(--supporter-agender-gradient-dark-gray)',
    'var(--supporter-agender-gradient-gray)',
    'var(--supporter-agender-gradient-light-gray)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-agender-gradient-light-green)',
    'var(--supporter-agender-gradient-green)',
    'var(--supporter-agender-gradient-light-green)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-agender-gradient-light-gray)',
    'var(--supporter-agender-gradient-gray)',
    'var(--supporter-agender-gradient-dark-gray)',
    'var(--supporter-black)',
  ],
  bisexual: [
    'var(--supporter-bisexual-gradient-pink)',
    'var(--supporter-bisexual-gradient-pink-purple)',
    'var(--supporter-bisexual-gradient-purple)',
    'var(--supporter-bisexual-gradient-blue-purple)',
    'var(--supporter-bisexual-gradient-blue)',
  ],
  pansexual: [
    'var(--supporter-pansexual-pink)',
    'var(--supporter-pansexual-gradient-orange)',
    'var(--supporter-pansexual-yellow)',
    'var(--supporter-pansexual-gradient-teal)',
    'var(--supporter-pansexual-blue)',
  ],
  transgradient: [
    'var(--supporter-trans-gradient-blue)',
    'var(--supporter-trans-gradient-purple)',
    'var(--supporter-trans-gradient-pink)',
    'var(--supporter-trans-gradient-light-pink)',
    'var(--supporter-white)',
  ],
  intersex: [
    'var(--supporter-intersex-gradient-yellow)',
    'var(--supporter-intersex-gradient-pink)',
    'var(--supporter-intersex-gradient-purple)',
  ],
  lesbian: [
    'var(--supporter-lesbian-gradient-orange)',
    'var(--supporter-lesbian-gradient-peach)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-lesbian-gradient-pink)',
    'var(--supporter-lesbian-gradient-magenta)',
  ],
  mlm: [
    'var(--supporter-mlm-gradient-green)',
    'var(--supporter-mlm-gradient-light-green)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-white)',
    'var(--supporter-mlm-gradient-light-purple)',
    'var(--supporter-mlm-gradient-blue)',
    'var(--supporter-mlm-gradient-indigo)',
    'var(--supporter-mlm-gradient-purple)',
  ],
  pride: [
    'var(--supporter-rainbow-gradient-red)',
    'var(--supporter-rainbow-gradient-orange)',
    'var(--supporter-rainbow-gradient-light-orange)',
    'var(--supporter-rainbow-gradient-gold)',
    'var(--supporter-rainbow-gradient-yellow)',
    'var(--supporter-rainbow-gradient-yellow)',
    'var(--supporter-rainbow-gradient-yellow)',
    'var(--supporter-rainbow-gradient-green)',
    'var(--supporter-rainbow-gradient-dark-green)',
    'var(--supporter-rainbow-gradient-teal)',
    'var(--supporter-rainbow-gradient-blue)',
    'var(--supporter-rainbow-gradient-purple)',
    'var(--supporter-rainbow-gradient-violet)',
  ],
};

function appIconStops(svg: string, colors: string[]) {
  const stops = [...svg.matchAll(/<stop\s+([^>]+)\/>/g)].map((match) => ({
    offset: /offset="([^"]+)"/.exec(match[1])?.[1] ?? '0',
  }));
  if (stops.length !== colors.length) {
    throw new Error(`App icon has ${stops.length} stops but ${colors.length} palette colors`);
  }
  return stops.map((stop, index) => ({ ...stop, color: colors[index] }));
}

const DONOR_PRIDE_COLORS = {
  nonbinary: [
    'var(--supporter-nonbinary-yellow)',
    'var(--supporter-white)',
    'var(--supporter-nonbinary-purple)',
    'var(--supporter-black)',
  ],
  genderfluid: [
    'var(--supporter-genderfluid-pink)',
    'var(--supporter-white)',
    'var(--supporter-genderfluid-purple)',
    'var(--supporter-black)',
    'var(--supporter-genderfluid-blue)',
  ],
  asexual: [
    'var(--supporter-asexual-black)',
    'var(--supporter-asexual-gray)',
    'var(--supporter-white)',
    'var(--supporter-asexual-purple)',
  ],
  aromantic: [
    'var(--supporter-aromantic-green)',
    'var(--supporter-aromantic-light-green)',
    'var(--supporter-white)',
    'var(--supporter-aromantic-gray)',
    'var(--supporter-black)',
  ],
  aroace: [
    'var(--supporter-aroace-orange)',
    'var(--supporter-aroace-yellow)',
    'var(--supporter-white)',
    'var(--supporter-aroace-blue)',
    'var(--supporter-aroace-navy)',
  ],
  graysexual: [
    'var(--supporter-graysexual-purple)',
    'var(--supporter-graysexual-gray)',
    'var(--supporter-graysexual-light-purple)',
    'var(--supporter-graysexual-gray)',
    'var(--supporter-graysexual-purple)',
  ],
  polysexual: [
    'var(--supporter-polysexual-pink)',
    'var(--supporter-polysexual-green)',
    'var(--supporter-polysexual-blue)',
  ],
  omnisexual: [
    'var(--supporter-omnisexual-light-pink)',
    'var(--supporter-omnisexual-pink)',
    'var(--supporter-omnisexual-purple)',
    'var(--supporter-omnisexual-blue)',
    'var(--supporter-omnisexual-light-blue)',
  ],
  genderqueer: [
    'var(--supporter-genderqueer-purple)',
    'var(--supporter-white)',
    'var(--supporter-genderqueer-green)',
  ],
  bigender: [
    'var(--supporter-bigender-pink)',
    'var(--supporter-bigender-light-pink)',
    'var(--supporter-bigender-lavender)',
    'var(--supporter-white)',
    'var(--supporter-bigender-lavender)',
    'var(--supporter-bigender-light-blue)',
    'var(--supporter-bigender-blue)',
  ],
  demigender: [
    'var(--supporter-demigender-gray)',
    'var(--supporter-demigender-light-gray)',
    'var(--supporter-demigender-yellow)',
    'var(--supporter-white)',
    'var(--supporter-demigender-yellow)',
    'var(--supporter-demigender-light-gray)',
    'var(--supporter-demigender-gray)',
  ],
  pluraljourney: [
    'var(--supporter-pluraljourney-green)',
    'var(--supporter-pluraljourney-blue)',
    'var(--supporter-pluraljourney-purple)',
    'var(--supporter-black)',
  ],
};

export const APP_ICON_STOPS: Record<string, Array<{ color: string; offset: string }>> = {
  ...Object.fromEntries(
    Object.entries(APP_ICON_SVGS).map(([variant, svg]) => [
      variant,
      appIconStops(svg, APP_ICON_PALETTE_COLORS[variant as keyof typeof APP_ICON_PALETTE_COLORS]),
    ])
  ),
  agendergradient: appIconStops(agender, APP_ICON_PALETTE_COLORS.agender),
  bisexualgradient: appIconStops(bisexual, APP_ICON_PALETTE_COLORS.bisexual),
  pansexualgradient: appIconStops(pansexual, APP_ICON_PALETTE_COLORS.pansexual),
  intersexgradient: appIconStops(intersex, APP_ICON_PALETTE_COLORS.intersex),
  lesbiangradient: appIconStops(lesbian, APP_ICON_PALETTE_COLORS.lesbian),
  mlmgradient: appIconStops(mlm, APP_ICON_PALETTE_COLORS.mlm),
  pridegradient: appIconStops(pride, APP_ICON_PALETTE_COLORS.pride),
  ...Object.fromEntries(
    Object.entries(DONOR_PRIDE_COLORS).map(([variant, colors]) => [
      `${variant}gradient`,
      colors.map((color, index) => ({ color, offset: String(index / (colors.length - 1)) })),
    ])
  ),
};

export function stripeStops(colors: string[]): Array<{ color: string; offset: string }> {
  const count = colors.length;
  return colors.flatMap((color, index) => [
    { color, offset: String(index / count) },
    { color, offset: String((index + 1) / count) },
  ]);
}

export const CRISP_PRIDE_STOPS: Partial<Record<string, Array<{ color: string; offset: string }>>> =
  {
    ...Object.fromEntries(
      Object.entries(DONOR_PRIDE_COLORS).map(([variant, colors]) => [variant, stripeStops(colors)])
    ),
    agender: stripeStops([
      'var(--supporter-black)',
      'var(--supporter-agender-gray)',
      'var(--supporter-white)',
      'var(--supporter-agender-green)',
      'var(--supporter-white)',
      'var(--supporter-agender-gray)',
      'var(--supporter-black)',
    ]),
    bisexual: [
      { color: 'var(--supporter-bisexual-pink)', offset: '0' },
      { color: 'var(--supporter-bisexual-pink)', offset: '0.4' },
      { color: 'var(--supporter-bisexual-purple)', offset: '0.4' },
      { color: 'var(--supporter-bisexual-purple)', offset: '0.6' },
      { color: 'var(--supporter-bisexual-blue)', offset: '0.6' },
      { color: 'var(--supporter-bisexual-blue)', offset: '1' },
    ],
    pansexual: stripeStops([
      'var(--supporter-pansexual-pink)',
      'var(--supporter-pansexual-yellow)',
      'var(--supporter-pansexual-blue)',
    ]),
    trans: stripeStops([
      'var(--supporter-trans-blue)',
      'var(--supporter-trans-pink)',
      'var(--supporter-white)',
      'var(--supporter-trans-pink)',
      'var(--supporter-trans-blue)',
    ]),
    intersex: [
      { color: 'var(--supporter-intersex-yellow)', offset: '0' },
      { color: 'var(--supporter-intersex-yellow)', offset: '0.38' },
      { color: 'var(--supporter-intersex-purple)', offset: '0.38' },
      { color: 'var(--supporter-intersex-purple)', offset: '0.58' },
      { color: 'var(--supporter-intersex-yellow)', offset: '0.58' },
      { color: 'var(--supporter-intersex-yellow)', offset: '1' },
    ],
    lesbian: stripeStops([
      'var(--supporter-lesbian-dark-orange)',
      'var(--supporter-lesbian-light-orange)',
      'var(--supporter-white)',
      'var(--supporter-lesbian-pink)',
      'var(--supporter-lesbian-dark-magenta)',
    ]),
    mlm: stripeStops([
      'var(--supporter-mlm-green)',
      'var(--supporter-mlm-light-green)',
      'var(--supporter-white)',
      'var(--supporter-mlm-light-blue)',
      'var(--supporter-mlm-indigo)',
    ]),
    pride: stripeStops([
      'var(--supporter-rainbow-red)',
      'var(--supporter-rainbow-orange)',
      'var(--supporter-rainbow-yellow)',
      'var(--supporter-rainbow-green)',
      'var(--supporter-rainbow-blue)',
      'var(--supporter-rainbow-violet)',
    ]),
    pluraljourney: [
      { color: 'var(--supporter-pluraljourney-green)', offset: '0' },
      { color: 'var(--supporter-pluraljourney-green)', offset: '0.38' },
      { color: 'var(--supporter-pluraljourney-blue)', offset: '0.38' },
      { color: 'var(--supporter-pluraljourney-blue)', offset: '0.58' },
      { color: 'var(--supporter-pluraljourney-purple)', offset: '0.58' },
      { color: 'var(--supporter-pluraljourney-purple)', offset: '0.78' },
      { color: 'var(--supporter-black)', offset: '0.78' },
      { color: 'var(--supporter-black)', offset: '1' },
    ],
  };
