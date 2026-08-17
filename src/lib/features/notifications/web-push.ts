import type { CoreClient } from '$lib/core/client.svelte';
import { preferences } from '$lib/settings/preferences.svelte';

const REGISTERED_ENDPOINT = 'sable-push-endpoint';

type PushConfig = {
  gateway: string;
  appId: string;
  vapid: string;
};

function config(): PushConfig | null {
  const gateway = import.meta.env.VITE_PUSH_GATEWAY_URL;
  const appId = import.meta.env.VITE_PUSH_WEB_APP_ID;
  const vapid = import.meta.env.VITE_PUSH_VAPID_KEY;
  if (!gateway || !appId || !vapid) return null;

  return { gateway, appId, vapid };
}

export function canReceivePush(): boolean {
  return (
    config() !== null &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in globalThis
  );
}

/** A VAPID key travels as base64url and `applicationServerKey` wants bytes. */
export function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.padEnd(key.length + ((4 - (key.length % 4)) % 4), '=');
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The browser can drop a subscription without telling the homeserver, so the
    endpoint we last registered is compared against the live one. */
export function needsRegistering(endpoint: string, registered: string | null): boolean {
  return endpoint !== registered;
}

export async function syncPushSubscription(core: CoreClient): Promise<void> {
  const settings = config();
  if (!settings || !canReceivePush() || Notification.permission !== 'granted') return;

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidBytes(settings.vapid),
    }));

  const { endpoint, keys } = subscription.toJSON();
  if (endpoint === undefined || !keys?.p256dh || !keys.auth) return;
  if (!needsRegistering(endpoint, localStorage.getItem(REGISTERED_ENDPOINT))) return;

  await core.setPusher({
    pushkey: keys.p256dh,
    app_id: settings.appId,
    url: settings.gateway,
    device_display_name: 'This browser',
    web_push: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
    event_id_only: !preferences.notificationContent,
    append: false,
  });
  localStorage.setItem(REGISTERED_ENDPOINT, endpoint);
}

/** Leaving a pusher behind keeps a signed-out browser on the server's push list. */
export async function dropPushSubscription(core: CoreClient): Promise<void> {
  const settings = config();
  if (!settings || !canReceivePush()) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  localStorage.removeItem(REGISTERED_ENDPOINT);
  if (!subscription) return;

  const { keys } = subscription.toJSON();
  if (keys?.p256dh) await core.removePusher(keys.p256dh, settings.appId);
  await subscription.unsubscribe();
}
