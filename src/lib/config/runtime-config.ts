import { asset } from '$app/paths';

/** Key names follow v1's `config.json` so a deployment can carry its file over. */
export type PushDetails = {
  pushNotifyUrl: string;
  vapidPublicKey: string;
  webPushAppID: string;
  nativePushAppID: string | null;
};

export type RuntimeConfig = {
  push: PushDetails | null;
};

const EMPTY: RuntimeConfig = { push: null };

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The three values a subscription needs are read as one unit; see
    `hasCompleteOverride` for why a partial set is worse than none. */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) return EMPTY;

  const details = (raw as { pushNotificationDetails?: unknown }).pushNotificationDetails;
  if (typeof details !== 'object' || details === null) return EMPTY;

  const source = details as Record<string, unknown>;
  const pushNotifyUrl = text(source.pushNotifyUrl);
  const vapidPublicKey = text(source.vapidPublicKey);
  const webPushAppID = text(source.webPushAppID);
  if (!pushNotifyUrl || !vapidPublicKey || !webPushAppID) return EMPTY;

  return {
    push: {
      pushNotifyUrl,
      vapidPublicKey,
      webPushAppID,
      nativePushAppID: text(source.nativePushAppID),
    },
  };
}

let loading: Promise<RuntimeConfig> | null = null;

/** Read once per session. A network failure is left uncached so that being
    offline at boot does not disable push until the tab is reloaded. */
export function runtimeConfig(): Promise<RuntimeConfig> {
  loading ??= fetch(asset('/config.json'), { cache: 'no-cache' })
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then(parseRuntimeConfig)
    .catch(() => {
      loading = null;
      return EMPTY;
    });

  return loading;
}
