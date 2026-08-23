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

export type RuntimeConfig = {
  push: PushDetails | null;
  gifs: GifsConfig;
};

const NO_GIFS: GifsConfig = {
  provider: null,
  proxyUrl: null,
  klipyApiKey: null,
  tenorApiKey: null,
  giphyApiKey: null,
};

const EMPTY: RuntimeConfig = { push: null, gifs: NO_GIFS };

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

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) return EMPTY;

  const source = raw as Record<string, unknown>;
  return {
    push: parsePush(source.pushNotificationDetails),
    gifs: parseGifs(source.gifs),
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
