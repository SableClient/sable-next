/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { version } from '$app/env';
import { resolve } from '$app/paths';

import favicon from '#lib/assets/favicon.png';
import {
  alertCooling,
  appendLine,
  hideLines,
  readLines,
  summarise,
} from '#lib/features/notifications/conversation.js';
import { notificationPermalink } from '#lib/features/notifications/notification-link.js';
import {
  alert,
  parsePushPayload,
  type PushPayload,
  silencedByRoomMode,
  unreadCount,
  webPushValidation,
} from '#lib/features/notifications/push-payload.js';
import {
  completePushPayload,
  namesOnlyItsEvent,
  readPushFetch,
} from '#lib/features/notifications/push-fetch.js';
import {
  isDiagnosticPush,
  pushTrace,
  type PushHistoryEntry,
} from '#lib/features/notifications/push-history.js';
import {
  pushContentPolicy,
  pushSession,
  recordPush,
  roomMode,
  roomName,
} from '#lib/features/notifications/room-names.js';
import type { PushFetchView } from '#src/generated/protocol';
import { reportWorkerError, watchWorkerOperation } from './telemetry.js';

const worker = globalThis.self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener('error', (event) => {
  void reportWorkerError('error', event.error ?? new Error(event.message)).catch(() => undefined);
});
worker.addEventListener('unhandledrejection', (event) => {
  void reportWorkerError('unhandledrejection', event.reason).catch(() => undefined);
});

worker.addEventListener('push', (event) => {
  const raw = event.data?.text();

  const validation = webPushValidation(raw);
  if (validation) {
    event.waitUntil(
      watchWorkerOperation(
        'push-validation',
        Promise.all([
          record('WEBPUSH_VALIDATION'),
          worker.clients.matchAll({ type: 'window', includeUncontrolled: true }),
        ]).then(([, clients]) => {
          for (const client of clients) {
            client.postMessage({
              type: 'sable:webpush-ack',
              appId: validation.appId,
              ackToken: validation.ackToken,
            });
          }
        })
      )
    );
    return;
  }

  event.waitUntil(watchWorkerOperation('push', present(parsePushPayload(raw) ?? undefined)));
});

worker.addEventListener('message', (event) => {
  const message = event.data as { type?: unknown } | undefined;
  if (message?.type === 'sable:skip-waiting')
    event.waitUntil(watchWorkerOperation('skip-waiting', worker.skipWaiting()));
  if (message?.type === 'sable:share-take')
    event.waitUntil(watchWorkerOperation('share-take', handShares()));
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
  event.respondWith(watchWorkerOperation('share', stashShare(event)));
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
  event.waitUntil(watchWorkerOperation('share-hold', holdShare(id)));

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

function record(outcome: string, trace: Omit<PushHistoryEntry, 'at' | 'outcome'> = {}) {
  return recordPush({ at: Date.now(), outcome, ...trace });
}

async function present(pushed: PushPayload | undefined): Promise<void> {
  if (!pushed) {
    await record('INVALID_PAYLOAD');
    return;
  }
  const trace = pushTrace(pushed);
  if (isDiagnosticPush(pushed)) {
    await record('DIAGNOSTIC_RECEIVED', trace);
    return;
  }

  const count = unreadCount(pushed);
  if (count !== null && 'setAppBadge' in navigator) {
    await navigator.setAppBadge(count).catch(() => undefined);
  }

  if (await focused()) {
    await record('APP_FOCUSED', trace);
    return;
  }
  const fetched = namesOnlyItsEvent(pushed);
  const payload = fetched ? await fetchEvent(pushed) : pushed;
  if (!payload) {
    await record('DISCARDED', trace);
    return;
  }
  if (fetched) await record(payload.notification?.type ? 'FETCHED' : 'FETCH_FAILED', trace);
  if (silencedByRoomMode(payload, await roomMode(payload.notification?.room_id ?? ''))) {
    await record('ROOM_MODE_SILENCED', trace);
    return;
  }

  const policy = await pushContentPolicy();
  const encrypted =
    payload.notification?.type === 'm.room.encrypted' || payload.notification?.decrypted === true;
  const showContent = policy.content && (!encrypted || policy.encryptedContent);
  const showing = alert(payload, await roomName(payload.notification?.room_id ?? ''), showContent);
  if (!showing) {
    await record('BADGE_ONLY', trace);
    return;
  }

  const { lines: held, alertedAt } = await conversation(showing.tag);
  const lines = appendLine(showContent ? held : hideLines(held), showing.line);
  const now = Date.now();
  const renotify =
    !policy.notifyOnce ||
    held.length === 0 ||
    payload.notification?.noisy === true ||
    !alertCooling(alertedAt, now);

  const options: NotificationOptions & {
    renotify?: boolean;
    timestamp?: number;
    actions?: { action: string; title: string }[];
  } = {
    body: lines.length > 1 ? summarise(lines) : showing.body,
    tag: showing.tag,
    renotify,
    icon: payload.notification?.icon ?? favicon,
    badge: favicon,
    timestamp: now,
    data: {
      roomId: showing.roomId,
      userId: payload.notification?.user_id,
      eventId: showing.eventId,
      invite: showing.invite,
      lines,
      alertedAt: renotify ? now : alertedAt,
    },
  };
  if (showing.ring) {
    options.actions = [
      { action: 'answer', title: 'Answer' },
      { action: 'decline', title: 'Decline' },
    ];
    options.requireInteraction = true;
  }
  if (showing.invite) {
    options.actions = [
      { action: 'accept', title: 'Accept' },
      { action: 'decline', title: 'Decline' },
    ];
  }

  await worker.registration.showNotification(showing.title, options);
  await record('POSTED', trace);
}

async function fetchEvent(payload: PushPayload): Promise<PushPayload | null> {
  const session = await pushSession(payload.notification?.user_id);
  if (!session) return payload;
  return completePushPayload(
    { notification: { ...payload.notification, user_id: session.userId } },
    {
      session,
      fetch: (input, init) => fetch(input, init),
      roomName,
      decrypt: (roomId, eventId) => decryptInTab(roomId, eventId, session.userId),
    }
  );
}

const DECRYPT_TIMEOUT_MS = 5000;

async function decryptInTab(
  roomId: string,
  eventId: string,
  userId: string
): Promise<PushFetchView | null> {
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    const answer = await new Promise<PushFetchView | null>((settle) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        settle(null);
      }, DECRYPT_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        settle(readPushFetch(event.data));
      };
      client.postMessage({ type: 'sable:push-event', roomId, eventId, userId }, [channel.port2]);
    });
    if (answer !== null) return answer;
  }
  return null;
}

async function focused(): Promise<boolean> {
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some((client) => client.focused);
}

async function conversation(
  tag: string
): Promise<{ lines: ReturnType<typeof readLines>; alertedAt: number | undefined }> {
  if (!('getNotifications' in worker.registration)) return { lines: [], alertedAt: undefined };
  const open = await worker.registration.getNotifications({ tag });
  const previous = open.at(-1)?.data as { lines?: unknown; alertedAt?: unknown } | undefined;
  const alertedAt = previous?.alertedAt;
  return {
    lines: readLines(previous?.lines),
    alertedAt: typeof alertedAt === 'number' ? alertedAt : undefined,
  };
}

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as
    | { roomId?: string; userId?: string; eventId?: string | null; invite?: boolean }
    | undefined;
  if (event.action === 'answer' || event.action === 'decline') {
    event.waitUntil(
      watchWorkerOperation(
        'call-action',
        callAction(event.action, data?.roomId, data?.userId, data?.eventId ?? null)
      )
    );
    return;
  }
  if (event.action === 'accept' || event.action === 'decline') {
    event.waitUntil(
      watchWorkerOperation('invite-action', inviteAction(event.action, data?.roomId, data?.userId))
    );
    return;
  }
  if (data?.invite === true) {
    event.waitUntil(watchWorkerOperation('notificationclick', openInvites(data.userId)));
    return;
  }
  event.waitUntil(
    watchWorkerOperation(
      'notificationclick',
      open(data?.roomId, data?.userId, data?.eventId ?? undefined)
    )
  );
});

async function callAction(
  outcome: 'answer' | 'decline',
  roomId: string | undefined,
  userId: string | undefined,
  eventId: string | null
): Promise<void> {
  if (roomId === undefined || userId === undefined) return;
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = clients.at(0);
  if (client) {
    client.postMessage({ type: 'sable:call-action', outcome, roomId, userId, eventId });
    if (outcome === 'answer') await client.focus();
    return;
  }
  if (outcome === 'answer') {
    await worker.clients.openWindow(notificationPermalink(roomId, eventId ?? undefined, userId));
  }
}

async function inviteAction(
  outcome: 'accept' | 'decline',
  roomId: string | undefined,
  userId: string | undefined
): Promise<void> {
  if (roomId === undefined || userId === undefined) return;
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = clients.at(0);
  if (client) {
    client.postMessage({ type: 'sable:invite-action', outcome, roomId, userId });
    if (outcome === 'accept') await client.focus();
    return;
  }
  await worker.clients.openWindow(resolve('/(app)/inbox'));
}

async function openInvites(userId: string | undefined): Promise<void> {
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = clients.at(0);
  if (client) {
    client.postMessage({ type: 'sable:open-invites', userId });
    await client.focus();
    return;
  }
  await worker.clients.openWindow(resolve('/(app)/inbox'));
}

async function open(
  roomId: string | undefined,
  userId: string | undefined,
  eventId: string | undefined
): Promise<void> {
  const clients = await worker.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  const client = clients.at(0);
  if (client) {
    client.postMessage({ type: 'sable:open-room', roomId, userId, eventId });
    await client.focus();
    return;
  }

  await worker.clients.openWindow(
    roomId === undefined ? resolve('/') : notificationPermalink(roomId, eventId, userId)
  );
}

/** Only the app can re-register a replaced subscription, so it is told to. */
worker.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    watchWorkerOperation(
      'pushsubscriptionchange',
      worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) client.postMessage({ type: 'sable:push-resubscribe' });
      })
    )
  );
});
