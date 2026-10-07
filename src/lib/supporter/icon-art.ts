import logo from '#lib/assets/res/svg/logo.svg?raw';
import ghost from './ghost.svg?raw';
import agender from '#lib/features/settings/app-icons/agender.svg?raw';
import bisexual from '#lib/features/settings/app-icons/bisexual.svg?raw';
import pansexual from '#lib/features/settings/app-icons/pansexual.svg?raw';
import transgradient from '#lib/features/settings/app-icons/transgradient.svg?raw';
import intersex from '#lib/features/settings/app-icons/intersex.svg?raw';
import lesbian from '#lib/features/settings/app-icons/lesbian.svg?raw';
import mlm from '#lib/features/settings/app-icons/mlm.svg?raw';
import pride from '#lib/features/settings/app-icons/pride.svg?raw';

export const SABLE_PATHS = [...logo.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]);
export const GHOST_SABLE_PATH = /\bd="([^"]+)"/.exec(ghost)?.[1] ?? SABLE_PATHS[0];
export const SABLE_EYE_PATH = SABLE_PATHS[0].slice(SABLE_PATHS[0].lastIndexOf(' M ') + 1);

export const APP_ICON_STOPS = Object.fromEntries(
  Object.entries({
    agender,
    agendergradient: agender,
    bisexual,
    bisexualgradient: bisexual,
    pansexual,
    pansexualgradient: pansexual,
    transgradient,
    intersex,
    intersexgradient: intersex,
    lesbian,
    lesbiangradient: lesbian,
    mlm,
    mlmgradient: mlm,
    pride,
    pridegradient: pride,
  }).map(([variant, svg]) => [
    variant,
    [...svg.matchAll(/<stop\s+([^>]+)\/>/g)].map((match) => ({
      color: /stop-color="([^"]+)"/.exec(match[1])?.[1] ?? 'currentColor',
      offset: /offset="([^"]+)"/.exec(match[1])?.[1] ?? '0',
    })),
  ])
);

export function stripeStops(colors: string[]): Array<{ color: string; offset: string }> {
  const count = colors.length;
  return colors.flatMap((color, index) => [
    { color, offset: String(index / count) },
    { color, offset: String((index + 1) / count) },
  ]);
}

export const CRISP_PRIDE_STOPS: Partial<Record<string, Array<{ color: string; offset: string }>>> =
  {
    agender: stripeStops([
      'var(--supporter-black)',
      'var(--supporter-silver)',
      'var(--supporter-white)',
      'var(--supporter-green)',
      'var(--supporter-white)',
      'var(--supporter-silver)',
      'var(--supporter-black)',
    ]),
    bisexual: [
      { color: 'var(--supporter-bisexual-pink)', offset: '0' },
      { color: 'var(--supporter-bisexual-pink)', offset: '0.4' },
      { color: '#9b4797', offset: '0.4' },
      { color: '#9b4797', offset: '0.6' },
      { color: 'var(--supporter-bisexual-blue)', offset: '0.6' },
      { color: 'var(--supporter-bisexual-blue)', offset: '1' },
    ],
    pansexual: stripeStops([
      'var(--supporter-pansexual-pink)',
      'var(--supporter-pansexual-yellow)',
      'var(--supporter-pansexual-blue)',
    ]),
    trans: stripeStops([
      'var(--supporter-blue)',
      'var(--supporter-pink)',
      'var(--supporter-white)',
      'var(--supporter-pink)',
      'var(--supporter-blue)',
    ]),
    intersex: [
      { color: '#ffd900', offset: '0' },
      { color: '#ffd900', offset: '0.38' },
      { color: '#7902aa', offset: '0.38' },
      { color: '#7902aa', offset: '0.58' },
      { color: '#ffd900', offset: '0.58' },
      { color: '#ffd900', offset: '1' },
    ],
    lesbian: stripeStops(['#d52c00', '#ff9a56', '#ffffff', '#d461a6', '#a20262']),
    mlm: stripeStops(['#078d6f', '#98ca99', '#ffffff', '#7bade2', '#3f1a79']),
    pride: stripeStops([
      'var(--supporter-red)',
      'var(--supporter-orange)',
      'var(--supporter-yellow)',
      '#0c9b49',
      '#3954a5',
      '#792891',
    ]),
  };
