/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { base } from '$service-worker';

import { alert, type PushPayload, unreadCount } from '$lib/features/notifications/push-payload';
import { roomName } from '$lib/features/notifications/room-names';

const worker = globalThis.self as unknown as ServiceWorkerGlobalScope;

/** No `fetch` handler and no caches: an offline story nobody asked for would
    take over every request. */
worker.addEventListener('push', (event) => {
  event.waitUntil(present(event.data?.json() as PushPayload | undefined));
});

async function present(payload: PushPayload | undefined): Promise<void> {
  if (!payload) return;

  const count = unreadCount(payload);
  if (count !== null && 'setAppBadge' in navigator) {
    await navigator.setAppBadge(count).catch(() => undefined);
  }

  // `event_id_only` leaves nothing to reveal, so what arrives is what shows.
  const showing = alert(payload, await roomName(payload.notification?.room_id ?? ''), true);
  if (!showing) return;

  await worker.registration.showNotification(showing.title, {
    body: showing.body,
    tag: showing.tag,
    icon: `${base}/favicon.png`,
    data: { roomId: showing.roomId, eventId: showing.eventId },
  });
}

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const room = (event.notification.data as { roomId?: string } | undefined)?.roomId;
  event.waitUntil(open(room));
});

async function open(roomId: string | undefined): Promise<void> {
  const clients = await worker.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  const client = clients.at(0);
  if (client) {
    client.postMessage({ type: 'sable:open-room', roomId });
    await client.focus();
    return;
  }

  const target = roomId === undefined ? `${base}/` : `${base}/to/${encodeURIComponent(roomId)}`;
  await worker.clients.openWindow(target);
}

/** Only the app can re-register a replaced subscription, so it is told to. */
worker.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'sable:push-resubscribe' });
    })
  );
});
