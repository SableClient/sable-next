import { logoutRedirectUrl } from '#lib/deployment/policy.js';
import { base64ToUint8Array, uint8ArrayToBase64 } from 'uint8array-extras';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { appName } from '#lib/deployment/brand.js';
import { redirectAfterLogout } from '#lib/auth/logout-redirect.js';
import { readText, removeLocalValue, writeText } from '#lib/platform/local-json.js';
import { deliversWebPush } from '#lib/platform/notifications.js';
import { activeServiceWorker } from '#lib/platform/service-worker.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { unregisterNativePush } from './native-push';
import {
  hasCompleteOverride,
  pushConfig,
  type PushOverride,
  trimmed,
} from '#lib/notifications/push-config.js';
import { expectPushActivation, forgetPushSession } from '#lib/notifications/room-names.js';

const REGISTERED_ENDPOINT = 'sable-push-endpoint';

function fallback<T>(value: T, what: string): (error: unknown) => T {
  return (error) => {
    console.debug(`[sable notifications] ${what}`, error);
    return value;
  };
}

export const WEBPUSH_APP_ID = 'moe.sable.webpush';

/** The pusher kind the MSC4174 handshake lives under. */
export const SERVER_PUSHER_KIND = 'org.matrix.msc4174.webpush';
const GATEWAY_PUSHER_KIND = 'http';

/** A `null` gateway is MSC4174: the homeserver is the delivery. */
export type PushTarget = {
  gateway: string | null;
  appId: string;
  vapid: string;
};

/** A VAPID key travels as base64url and `applicationServerKey` wants bytes. */
export function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  return base64ToUint8Array(key);
}

/** A subscription is minted under one VAPID key and cannot be re-keyed. */
export function applicationServerKeyMatches(
  subscription: PushSubscription,
  vapid: string
): boolean {
  const key: unknown = (subscription.options as PushSubscriptionOptions | null | undefined)
    ?.applicationServerKey;
  const bytes = ArrayBuffer.isView(key)
    ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength)
    : key instanceof ArrayBuffer
      ? new Uint8Array(key)
      : null;
  return bytes !== null && uint8ArrayToBase64(bytes, { urlSafe: true }) === vapid;
}

/** Includes the gateway and app id because retargeting leaves the endpoint
    unchanged, and the endpoint alone would then look already registered. The
    VAPID joins them since a new key forces an actual re-subscribe. */
export function registrationMarker(
  accountId: string,
  endpoint: string,
  target: Pick<PushTarget, 'gateway' | 'appId' | 'vapid'>,
  eventIdOnly: boolean,
  name = ''
): string {
  return [
    accountId,
    target.gateway ?? '',
    target.appId,
    endpoint,
    String(eventIdOnly),
    target.vapid,
    name,
  ].join('\n');
}

export function pusherDisplayName(core: Pick<CoreClient, 'deviceList'>): string {
  const deviceName = core.deviceList.find((device) => device.is_own)?.display_name?.trim();
  return deviceName || appName();
}

export function needsRegistering(marker: string, registered: string | null): boolean {
  return marker !== registered;
}

/** A pusher left under the previous app id keeps pushing from the old gateway,
    doubling every notification. */
function abandonedAppId(registered: string | null, appId: string): string | null {
  const previous = registered?.split('\n')[2];
  return previous !== undefined && previous !== appId ? previous : null;
}

/** An override wins, then the homeserver's own delivery, then the gateway. */
async function pushTarget(core: CoreClient, override: PushOverride): Promise<PushTarget | null> {
  if (hasCompleteOverride(override)) {
    const { gateway, appId, vapid } = trimmed(override);
    return { gateway, appId, vapid };
  }

  const vapid = await core.rpc.push
    .webPusherSupport()
    .catch(fallback(null, 'server push support unavailable'));
  if (vapid !== null) return { gateway: null, appId: WEBPUSH_APP_ID, vapid };

  const { resolved: settings } = await pushConfig(override);
  return settings ?? null;
}

/** `false` while the pusher still awaits the validation handshake. Throws on
    an unreadable list: registering again would replace a token in flight. */
async function serverPusherActivated(
  core: CoreClient,
  pushkey: string,
  appId: string
): Promise<boolean | null> {
  const pushers = await core.rpc.push.webPushers();
  const mine = pushers.find(
    (pusher) =>
      pusher.pushkey === pushkey && pusher.app_id === appId && pusher.kind === SERVER_PUSHER_KIND
  );
  return mine?.activated ?? null;
}

/** A gateway pusher left beside the server delivery doubles every alert. */
async function removeStaleGatewayPushers(
  core: CoreClient,
  pushkey: string,
  rekeyed: string | null
): Promise<void> {
  const pushers = await core.rpc.push.webPushers().catch(fallback([], 'listing pushers failed'));
  for (const pusher of pushers) {
    if (pusher.kind !== GATEWAY_PUSHER_KIND) continue;
    if (pusher.pushkey !== pushkey && pusher.pushkey !== rekeyed) continue;
    await core.rpc.push
      .removePusher({ pushkey: pusher.pushkey, app_id: pusher.app_id })
      .catch(fallback(undefined, 'removing stale pusher failed'));
  }
}

const syncing = new Map<string, Promise<void>>();

/** Every MSC4174 registration replaces the pending ack token. */
export function syncPushSubscription(core: CoreClient, override: PushOverride): Promise<void> {
  const accountId = core.session?.account_id ?? '';
  const running = syncing.get(accountId);
  if (running) return running;
  const run = sync(core, override).finally(() => {
    syncing.delete(accountId);
  });
  syncing.set(accountId, run);
  return run;
}

async function sync(core: CoreClient, override: PushOverride): Promise<void> {
  if (!deliversWebPush() || Notification.permission !== 'granted') return;
  const accountId = core.session?.account_id;
  const userId = core.session?.user_id;
  if (!accountId || !userId) return;
  const target = await pushTarget(core, override);
  if (!target) return;

  const registration = await activeServiceWorker();
  if (!registration) return;
  let subscription = await registration.pushManager.getSubscription();
  let rekeyed: string | null = null;
  if (subscription && !applicationServerKeyMatches(subscription, target.vapid)) {
    rekeyed = subscription.toJSON().keys?.p256dh ?? null;
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidBytes(target.vapid),
    });
  }

  const { endpoint, keys } = subscription.toJSON();
  if (endpoint === undefined || !keys?.p256dh || !keys.auth) return;

  const registered = readText(REGISTERED_ENDPOINT);
  const eventIdOnly = !preferences.richPushPayloads;
  const name = pusherDisplayName(core);
  const marker = registrationMarker(accountId, endpoint, target, eventIdOnly, name);

  if (target.gateway !== null) {
    if (!needsRegistering(marker, registered)) return;

    const abandoned = abandonedAppId(registered, target.appId);
    if (abandoned) {
      await core.rpc.push
        .removePusher({ pushkey: keys.p256dh, app_id: abandoned })
        .catch(fallback(undefined, 'removing abandoned pusher failed'));
    }

    await core.rpc.push.setPusher({
      pusher: {
        pushkey: keys.p256dh,
        app_id: target.appId,
        url: target.gateway,
        device_display_name: name,
        web_push: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
        event_id_only: eventIdOnly,
        append: false,
      },
    });
    writeText(REGISTERED_ENDPOINT, marker);
    return;
  }

  if (needsRegistering(marker, registered)) {
    const abandoned = abandonedAppId(registered, target.appId);
    if (abandoned) {
      await core.rpc.push
        .removePusher({ pushkey: keys.p256dh, app_id: abandoned })
        .catch(fallback(undefined, 'removing abandoned pusher failed'));
    }
  } else {
    const activated = await serverPusherActivated(core, keys.p256dh, target.appId);
    if (activated === true) return;
  }

  await removeStaleGatewayPushers(core, keys.p256dh, rekeyed);
  await expectPushActivation(userId);
  await core.rpc.push.setWebPusher({
    pusher: {
      pushkey: keys.p256dh,
      app_id: target.appId,
      device_display_name: name,
      endpoint,
      auth: keys.auth,
      event_id_only: eventIdOnly,
    },
  });
  writeText(REGISTERED_ENDPOINT, marker);
}

/** The p256dh of this browser's live subscription, which is the pushkey its
    own pushers carry; `null` where no service worker hosts a subscription. */
export async function currentPushKey(): Promise<string | null> {
  if (!deliversWebPush()) return null;
  const registration = await navigator.serviceWorker
    .getRegistration()
    .catch(fallback(undefined, 'service worker registration unavailable'));
  const subscription = (await registration?.pushManager.getSubscription()) ?? null;
  return subscription?.toJSON().keys?.p256dh ?? null;
}

/** Leaving a pusher behind keeps a signed-out browser on the server's push list. */
export async function dropPushSubscription(
  core: CoreClient,
  override: PushOverride
): Promise<void> {
  if (!deliversWebPush()) return;
  const target = await pushTarget(core, override).catch(
    fallback(undefined, 'push target unavailable')
  );
  const { resolved: settings } = await pushConfig(override);

  const registration = await navigator.serviceWorker
    .getRegistration()
    .catch(fallback(undefined, 'service worker registration unavailable'));
  removeLocalValue(REGISTERED_ENDPOINT);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const { keys } = subscription.toJSON();
  const appId = target?.appId ?? settings?.appId;
  if (keys?.p256dh && appId !== undefined) {
    await core.rpc.push.removePusher({ pushkey: keys.p256dh, app_id: appId });
  }
  await subscription.unsubscribe();
}

export async function logoutWithPush(core: CoreClient, override: PushOverride): Promise<void> {
  const session = core.session;
  await Promise.allSettled([
    dropPushSubscription(core, override),
    session === null ? undefined : unregisterNativePush(session),
    session === null ? undefined : forgetPushSession(session.user_id),
  ]);
  const redirectUrl = logoutRedirectUrl();
  await core.logout();
  redirectAfterLogout(core, redirectUrl);
}
