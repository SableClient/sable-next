import logo from '#lib/assets/res/svg/logo.svg?raw';
import agender from '#lib/features/settings/app-icons/agender.svg?raw';
import bisexual from '#lib/features/settings/app-icons/bisexual.svg?raw';
import transgradient from '#lib/features/settings/app-icons/transgradient.svg?raw';
import intersex from '#lib/features/settings/app-icons/intersex.svg?raw';
import lesbian from '#lib/features/settings/app-icons/lesbian.svg?raw';
import mlm from '#lib/features/settings/app-icons/mlm.svg?raw';
import pride from '#lib/features/settings/app-icons/pride.svg?raw';

export const SABLE_PATHS = [...logo.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]);

export const APP_ICON_STOPS = Object.fromEntries(
  Object.entries({ agender, bisexual, transgradient, intersex, lesbian, mlm, pride }).map(
    ([variant, svg]) => [
      variant,
      [...svg.matchAll(/<stop\s+([^>]+)\/>/g)].map((match) => ({
        color: /stop-color="([^"]+)"/.exec(match[1])?.[1] ?? 'currentColor',
        offset: /offset="([^"]+)"/.exec(match[1])?.[1] ?? '0',
      })),
    ]
  )
);
