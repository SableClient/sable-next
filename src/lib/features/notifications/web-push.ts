import { runtimeConfig } from '#lib/config/runtime-config.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { deliversWebPush } from '#lib/platform/notifications.js';
import { activeServiceWorker } from '#lib/platform/service-worker.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { unregisterNativePush } from './native-push';
import { hasCompleteOverride, pushConfig, type PushOverride, trimmed } from './push-config';

const REGISTERED_ENDPOINT = 'sable-push-endpoint';

/** For a deployment that ships no gateway configuration at all. */
const WEBPUSH_APP_ID = 'moe.sable.webpush';

/** The pusher kind the MSC4174 handshake lives under. */
const SERVER_PUSHER_KIND = 'org.matrix.msc4174.webpush';
const GATEWAY_PUSHER_KIND = 'http';

/** A `null` gateway is MSC4174: the homeserver is the delivery. */
export type PushTarget = {
  gateway: string | null;
  appId: string;
  vapid: string;
};

/** A VAPID key travels as base64url and `applicationServerKey` wants bytes. */
export function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.padEnd(key.length + ((4 - (key.length % 4)) % 4), '=');
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  return bytes !== null && base64url(bytes) === vapid;
}

/** Includes the gateway and app id because retargeting leaves the endpoint
    unchanged, and the endpoint alone would then look already registered. The
    VAPID joins them since a new key forces an actual re-subscribe. */
export function registrationMarker(
  accountId: string,
  endpoint: string,
  target: Pick<PushTarget, 'gateway' | 'appId' | 'vapid'>,
  eventIdOnly: boolean
): string {
  return [
    accountId,
    target.gateway ?? '',
    target.appId,
    endpoint,
    String(eventIdOnly),
    target.vapid,
  ].join('\n');
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

  const { vapid } = await core.commands.webPusherSupport().catch(() => ({ vapid: null }));
  const { push } = await runtimeConfig();
  if (vapid !== null) {
    return { gateway: null, appId: push?.webPushAppID ?? WEBPUSH_APP_ID, vapid };
  }

  const { resolved: settings } = await pushConfig(override);
  return settings ?? null;
}

/** `false` while the pusher still awaits the validation handshake. */
async function serverPusherActivated(
  core: CoreClient,
  pushkey: string,
  appId: string
): Promise<boolean | null> {
  const pushers = await core.commands.webPushers().catch(() => []);
  const mine = pushers.find(
    (pusher) =>
      pusher.pushkey === pushkey && pusher.app_id === appId && pusher.kind === SERVER_PUSHER_KIND
  );
  return mine?.activated ?? null;
}

/** A gateway pusher left beside the server delivery doubles every alert. */
async function removeStaleGatewayPusher(
  core: CoreClient,
  appId: string,
  pushkey: string
): Promise<void> {
  const pushers = await core.commands.webPushers().catch(() => []);
  const stale = pushers.some(
    (pusher) =>
      pusher.app_id === appId && pusher.pushkey === pushkey && pusher.kind === GATEWAY_PUSHER_KIND
  );
  if (stale) await core.commands.removePusher(pushkey, appId).catch(() => undefined);
}

export async function syncPushSubscription(
  core: CoreClient,
  override: PushOverride
): Promise<void> {
  if (!deliversWebPush() || Notification.permission !== 'granted') return;
  const accountId = core.session?.account_id;
  if (!accountId) return;
  const target = await pushTarget(core, override);
  if (!target) return;

  const registration = await activeServiceWorker();
  if (!registration) return;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !applicationServerKeyMatches(subscription, target.vapid)) {
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

  const registered = localStorage.getItem(REGISTERED_ENDPOINT);
  const eventIdOnly = !preferences.richPushPayloads;
  const marker = registrationMarker(accountId, endpoint, target, eventIdOnly);

  if (target.gateway !== null) {
    if (!needsRegistering(marker, registered)) return;

    const abandoned = abandonedAppId(registered, target.appId);
    if (abandoned) await core.commands.removePusher(keys.p256dh, abandoned).catch(() => undefined);

    await core.commands.setPusher({
      pushkey: keys.p256dh,
      app_id: target.appId,
      url: target.gateway,
      device_display_name: 'This browser',
      web_push: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
      event_id_only: eventIdOnly,
      append: false,
    });
    localStorage.setItem(REGISTERED_ENDPOINT, marker);
    return;
  }

  if (needsRegistering(marker, registered)) {
    const abandoned = abandonedAppId(registered, target.appId);
    if (abandoned) await core.commands.removePusher(keys.p256dh, abandoned).catch(() => undefined);
  } else {
    const activated = await serverPusherActivated(core, keys.p256dh, target.appId);
    if (activated !== false) return;
  }

  await removeStaleGatewayPusher(core, target.appId, keys.p256dh);
  await core.commands.setWebPusher({
    pushkey: keys.p256dh,
    app_id: target.appId,
    device_display_name: 'This browser',
    endpoint,
    auth: keys.auth,
    event_id_only: eventIdOnly,
  });
  localStorage.setItem(REGISTERED_ENDPOINT, marker);
}

/** Leaving a pusher behind keeps a signed-out browser on the server's push list. */
export async function dropPushSubscription(
  core: CoreClient,
  override: PushOverride
): Promise<void> {
  if (!deliversWebPush()) return;
  const target = await pushTarget(core, override).catch(() => undefined);
  const { resolved: settings } = await pushConfig(override);

  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  localStorage.removeItem(REGISTERED_ENDPOINT);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const { keys } = subscription.toJSON();
  const appId = target?.appId ?? settings?.appId;
  if (keys?.p256dh && appId !== undefined) {
    await core.commands.removePusher(keys.p256dh, appId);
  }
  await subscription.unsubscribe();
}

export async function logoutWithPush(core: CoreClient, override: PushOverride): Promise<void> {
  await Promise.allSettled([dropPushSubscription(core, override), unregisterNativePush()]);
  await core.logout();
}
