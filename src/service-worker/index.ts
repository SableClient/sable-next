/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { version } from '$app/env';
import { resolve } from '$app/paths';

import favicon from '#lib/assets/favicon.png';
import {
  appendLine,
  hideLines,
  readLines,
  summarise,
} from '#lib/features/notifications/conversation.js';
import {
  alert,
  parsePushPayload,
  type PushPayload,
  unreadCount,
  webPushValidation,
} from '#lib/features/notifications/push-payload.js';
import { pushContentPolicy, roomName } from '#lib/features/notifications/room-names.js';

const worker = globalThis.self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener('push', (event) => {
  const raw = event.data?.text();

  const validation = webPushValidation(raw);
  if (validation) {
    event.waitUntil(
      worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({
            type: 'sable:webpush-ack',
            appId: validation.appId,
            ackToken: validation.ackToken,
          });
        }
      })
    );
    return;
  }

  event.waitUntil(present(parsePushPayload(raw) ?? undefined));
});

worker.addEventListener('message', (event) => {
  const message = event.data as { type?: unknown } | undefined;
  if (message?.type === 'sable:skip-waiting') event.waitUntil(worker.skipWaiting());
  if (message?.type === 'sable:share-take') event.waitUntil(handShares());
  if (message?.type === 'sable:version') event.ports[0]?.postMessage(version);
});

interface StashedShare {
  text: string;
  files: File[];
}

const shareAction = `${resolve('/').replace(/\/$/, '')}/share`;
const shares = new Map<string, StashedShare>();

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== shareAction) return;
  event.respondWith(stashShare(event));
});

const SHARE_HOLD_MS = 15_000;

async function stashShare(event: FetchEvent): Promise<Response> {
  const form = await event.request.formData();
  const text = ['title', 'text', 'url']
    .map((field) => form.get(field))
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join('\n');
  const files = form.getAll('files').filter((value): value is File => value instanceof File);

  const id = crypto.randomUUID();
  shares.set(id, { text, files });
  event.waitUntil(holdShare(id));

  return Response.redirect(resolve('/'), 303);
}

async function holdShare(id: string): Promise<void> {
  const deadline = Date.now() + SHARE_HOLD_MS;
  while (shares.has(id) && Date.now() < deadline) {
    await handShares();
    if (!shares.has(id)) return;
    await new Promise((settle) => setTimeout(settle, 250));
  }
  shares.delete(id);
}

async function handShares(): Promise<void> {
  if (shares.size === 0) return;

  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = clients.at(0);
  if (!client) return;

  for (const [id, share] of shares) {
    shares.delete(id);
    client.postMessage({ type: 'sable:share', text: share.text, files: share.files });
  }
}

async function present(payload: PushPayload | undefined): Promise<void> {
  if (!payload) return;

  const count = unreadCount(payload);
  if (count !== null && 'setAppBadge' in navigator) {
    await navigator.setAppBadge(count).catch(() => undefined);
  }

  if (await focused()) return;

  const policy = await pushContentPolicy();
  const encrypted = payload.notification?.type === 'm.room.encrypted';
  const showContent = policy.content && (!encrypted || policy.encryptedContent);
  const showing = alert(payload, await roomName(payload.notification?.room_id ?? ''), showContent);
  if (!showing) return;

  const held = await conversation(showing.tag);
  const lines = appendLine(showContent ? held : hideLines(held), showing.line);

  const options: NotificationOptions & { renotify?: boolean; timestamp?: number } = {
    body: lines.length > 1 ? summarise(lines) : showing.body,
    tag: showing.tag,
    renotify: true,
    icon: favicon,
    badge: favicon,
    timestamp: Date.now(),
    data: { roomId: showing.roomId, lines },
  };

  await worker.registration.showNotification(showing.title, options);
}

async function focused(): Promise<boolean> {
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some((client) => client.focused);
}

async function conversation(tag: string): Promise<ReturnType<typeof readLines>> {
  const open = await worker.registration.getNotifications({ tag });
  const previous = open.at(-1)?.data as { lines?: unknown } | undefined;
  return readLines(previous?.lines);
}

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { roomId?: string } | undefined;
  event.waitUntil(open(data?.roomId));
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

  await worker.clients.openWindow(roomId === undefined ? resolve('/') : permalink(roomId));
}

function permalink(roomId: string): string {
  return resolve('/(app)/to/[...permalink]', {
    permalink: encodeURIComponent(roomId),
  });
}

/** Only the app can re-register a replaced subscription, so it is told to. */
worker.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'sable:push-resubscribe' });
    })
  );
});
