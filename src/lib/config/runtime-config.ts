import { asset } from '$app/paths';

import {
  gifProviderIds,
  type GifProviderId,
  type GifsConfig,
} from '#lib/features/gif/providers.js';

/** Key names follow v1's `config.json` so a deployment can carry its file over. */
export type PushDetails = {
  pushNotifyUrl: string;
  vapidPublicKey: string;
  webPushAppID: string;
  nativePushAppID: string | null;
};

export type HomeserversConfig = {
  list: string[];
  default: string;
  allowCustom: boolean;
};

export type RuntimeConfig = {
  push: PushDetails | null;
  gifs: GifsConfig;
  homeservers: HomeserversConfig;
};

const NO_GIFS: GifsConfig = {
  provider: null,
  proxyUrl: null,
  klipyApiKey: null,
  tenorApiKey: null,
  giphyApiKey: null,
};

export const BUILT_IN_HOMESERVERS: HomeserversConfig = {
  list: ['matrix.org', 'mozilla.org', 'unredacted.org', 'sable.moe', 'kendama.moe'],
  default: 'matrix.org',
  allowCustom: true,
};

const EMPTY: RuntimeConfig = {
  push: null,
  gifs: NO_GIFS,
  homeservers: BUILT_IN_HOMESERVERS,
};

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The three values a subscription needs are read as one unit; see
    `hasCompleteOverride` for why a partial set is worse than none. */
function parsePush(raw: unknown): PushDetails | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const source = raw as Record<string, unknown>;
  const pushNotifyUrl = text(source.pushNotifyUrl);
  const vapidPublicKey = text(source.vapidPublicKey);
  const webPushAppID = text(source.webPushAppID);
  if (!pushNotifyUrl || !vapidPublicKey || !webPushAppID) return null;

  return {
    pushNotifyUrl,
    vapidPublicKey,
    webPushAppID,
    nativePushAppID: text(source.nativePushAppID),
  };
}

function parseGifs(raw: unknown): GifsConfig {
  if (typeof raw !== 'object' || raw === null) return NO_GIFS;

  const source = raw as Record<string, unknown>;
  const named = text(source.provider);

  return {
    provider: gifProviderIds.includes(named as GifProviderId) ? (named as GifProviderId) : null,
    proxyUrl: text(source.proxyUrl),
    klipyApiKey: text(source.klipyApiKey),
    tenorApiKey: text(source.tenorApiKey),
    giphyApiKey: text(source.giphyApiKey),
  };
}

function parseHomeservers(raw: unknown, allowCustom: unknown): HomeserversConfig {
  const list = Array.isArray(raw)
    ? [...new Set(raw.map(text).filter((server): server is string => server !== null))]
    : [];
  const custom = typeof allowCustom === 'boolean' ? allowCustom : BUILT_IN_HOMESERVERS.allowCustom;

  if (list.length === 0) return { ...BUILT_IN_HOMESERVERS, allowCustom: custom };
  return { list, default: list[0], allowCustom: custom };
}

function withDefaultAt(homeservers: HomeserversConfig, index: unknown): HomeserversConfig {
  if (typeof index !== 'number' || !Number.isInteger(index)) return homeservers;
  if (index < 0 || index >= homeservers.list.length) return homeservers;

  return { ...homeservers, default: homeservers.list[index] };
}

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) return EMPTY;

  const source = raw as Record<string, unknown>;
  return {
    push: parsePush(source.pushNotificationDetails),
    gifs: parseGifs(source.gifs),
    homeservers: withDefaultAt(
      parseHomeservers(source.homeserverList, source.allowCustomHomeservers),
      source.defaultHomeserver
    ),
  };
}

let loading: Promise<RuntimeConfig> | null = null;

/** Read once per session. A network failure is left uncached so that being
    offline at boot does not disable push until the tab is reloaded. */
export function runtimeConfig(): Promise<RuntimeConfig> {
  loading ??= fetch(asset('config.json'), { cache: 'no-cache' })
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then(parseRuntimeConfig)
    .catch(() => {
      loading = null;
      return EMPTY;
    });

  return loading;
}
