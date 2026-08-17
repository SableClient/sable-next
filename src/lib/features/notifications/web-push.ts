import type { CoreClient } from '$lib/core/client.svelte';
import { preferences } from '$lib/settings/preferences.svelte';

import { type PushConfig, pushConfig, type PushOverride } from './push-config';

const REGISTERED_ENDPOINT = 'sable-push-endpoint';

export function canReceivePush(): boolean {
  return (
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in globalThis
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

/** Includes the gateway and app id because retargeting leaves the endpoint
    unchanged, and the endpoint alone would then look already registered. */
export function registrationMarker(endpoint: string, settings: PushConfig): string {
  return [settings.gateway, settings.appId, endpoint].join('\n');
}

export function needsRegistering(marker: string, registered: string | null): boolean {
  return marker !== registered;
}

/** A pusher left under the previous app id keeps pushing from the old gateway,
    doubling every notification. */
function abandonedAppId(registered: string | null, appId: string): string | null {
  const previous = registered?.split('\n')[1];
  return previous !== undefined && previous !== appId ? previous : null;
}

export async function syncPushSubscription(
  core: CoreClient,
  override: PushOverride
): Promise<void> {
  if (!canReceivePush() || Notification.permission !== 'granted') return;
  const { resolved: settings } = await pushConfig(override);
  if (!settings) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidBytes(settings.vapid),
    }));

  const { endpoint, keys } = subscription.toJSON();
  if (endpoint === undefined || !keys?.p256dh || !keys.auth) return;

  const registered = localStorage.getItem(REGISTERED_ENDPOINT);
  const marker = registrationMarker(endpoint, settings);
  if (!needsRegistering(marker, registered)) return;

  const abandoned = abandonedAppId(registered, settings.appId);
  if (abandoned) await core.removePusher(keys.p256dh, abandoned).catch(() => undefined);

  await core.setPusher({
    pushkey: keys.p256dh,
    app_id: settings.appId,
    url: settings.gateway,
    device_display_name: 'This browser',
    web_push: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
    event_id_only: !preferences.notificationContent,
    append: false,
  });
  localStorage.setItem(REGISTERED_ENDPOINT, marker);
}

/** Leaving a pusher behind keeps a signed-out browser on the server's push list. */
export async function dropPushSubscription(
  core: CoreClient,
  override: PushOverride
): Promise<void> {
  if (!canReceivePush()) return;
  const { resolved: settings } = await pushConfig(override);
  if (!settings) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  localStorage.removeItem(REGISTERED_ENDPOINT);
  if (!subscription) return;

  const { keys } = subscription.toJSON();
  if (keys?.p256dh) await core.removePusher(keys.p256dh, settings.appId);
  await subscription.unsubscribe();
}
