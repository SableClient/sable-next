/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { version } from '$app/env';
import { resolve } from '$app/paths';

import { runtimeConfig } from '#lib/config/runtime-config.js';
import { DEFAULT_APP_NAME } from '#lib/deployment/default-app-name.js';
import favicon from '#lib/assets/favicon.png';
import { alertCooling } from '#lib/features/notifications/alert-cooldown.js';
import { isRingingCall, type PresentedAlertData } from '#lib/features/notifications/call-alert.js';
import { notificationPermalink } from '#lib/features/notifications/notification-link.js';
import {
  activeElsewhere,
  parsePushPayload,
  pushAlert,
  type PushNotification,
  silencedByRoomMode,
  type WebPushValidation,
  webPushValidation,
} from '#lib/notifications/push-payload.js';
import {
  acknowledgeWebPusher,
  completePushPayload,
  fetchDeviceActivity,
  isRtcInvite,
  namesOnlyItsEvent,
  readPushRooms,
  readPushFetch,
  type CompletedPushNotification,
} from '#lib/features/notifications/push-fetch.js';
import {
  isDiagnosticPush,
  pushTrace,
  type PushHistoryEntry,
} from '#lib/notifications/push-history.js';
import {
  currentServerUser,
  pushContentPolicy,
  pendingPushActivations,
  pushSession,
  recordPush,
  roomMode,
  roomName,
  settlePushActivation,
} from '#lib/notifications/room-names.js';
import { loadModel } from '#lib/model/model.js';
import modelWasm from '#src/generated/wasm/sable_model_bg.wasm?url';
import type { PushFetchView } from '#src/generated/protocol';
import { reportWorkerError, watchWorkerOperation } from './telemetry.js';
import { roomsToReconcile } from './read-reconcile.js';
import { belongsToServerUser, clientHasServerIdentity } from './push-scope.js';

const worker = globalThis.self as unknown as ServiceWorkerGlobalScope;

// A worker from an older deploy must not depend on assets the next deploy removed.
const MODEL_CACHE = `sable-model-${version}`;

function supportsModelCache(): boolean {
  return worker.location.protocol === 'https:' || worker.location.protocol === 'http:';
}

// The SPA fallback answers a missing asset with index.html and a 200, which cache.add would store as the model.
async function fetchModel(): Promise<Response> {
  const response = await fetch(modelWasm);
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`model wasm unavailable: ${String(response.status)}`);
  }
  return response;
}

worker.addEventListener('install', (event) => {
  if (!supportsModelCache()) return;
  event.waitUntil(
    Promise.all([caches.open(MODEL_CACHE), fetchModel()]).then(([cache, response]) =>
      cache.put(modelWasm, response)
    )
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('sable-model-') && name !== MODEL_CACHE)
            .map((name) => caches.delete(name))
        )
      )
  );
});

async function cachedModel(): Promise<Response> {
  if (!supportsModelCache()) return fetchModel();
  const cached = await caches.match(modelWasm, { cacheName: MODEL_CACHE });
  if (cached && !cached.headers.get('content-type')?.includes('text/html')) return cached;
  const response = await fetchModel();
  const cache = await caches.open(MODEL_CACHE);
  await cache.put(modelWasm, response.clone());
  return response;
}

worker.addEventListener('error', (event) => {
  void reportWorkerError('error', event.error ?? new Error(event.message)).catch(
    (error: unknown) => {
      console.debug('[sable service-worker] error not reported', error);
    }
  );
});
worker.addEventListener('unhandledrejection', (event) => {
  void reportWorkerError('unhandledrejection', event.reason).catch((error: unknown) => {
    console.debug('[sable service-worker] rejection not reported', error);
  });
});

worker.addEventListener('push', (event) => {
  const raw = event.data?.text();
  event.waitUntil(
    watchWorkerOperation(
      'push',
      loadModel(cachedModel()).then(() => receive(raw))
    ).catch(showFallback)
  );
});

let workerName: Promise<string> | null = null;

function workerAppName(): Promise<string> {
  workerName ??= runtimeConfig().then((config) => config.branding.appName ?? DEFAULT_APP_NAME);
  return workerName;
}

/** Safari revokes the subscription of a push that shows nothing. */
async function showFallback(): Promise<void> {
  await record('FALLBACK_SHOWN');
  await worker.registration.showNotification(await workerAppName(), {
    body: 'New message',
    tag: 'sable-fallback',
    icon: favicon,
    badge: favicon,
  });
}

async function receive(raw: string | undefined): Promise<void> {
  const validation = webPushValidation(raw);
  if (validation) {
    await watchWorkerOperation('push-validation', acknowledge(validation));
    return;
  }
  const pushed = parsePushPayload(raw) ?? undefined;
  const serverUserId = import.meta.env.VITE_SABLE_SERVER_URL ? await currentServerUser() : null;
  if (serverUserId && pushed) {
    if (
      !(await belongsToServerUser(pushed.user_id, pushSession)) ||
      (await currentServerUser()) !== serverUserId
    ) {
      await showFallback();
      return;
    }
  }
  await present(pushed, serverUserId);
  if (serverUserId && (await currentServerUser()) !== serverUserId) return;
  if (
    pushed &&
    pushed.unread !== 0 &&
    !isDiagnosticPush(pushed) &&
    (await pushContentPolicy()).clearOnRead &&
    (await reconcileRead(pushed))
  ) {
    await record('READ_DISMISSED', pushTrace(pushed));
  }
}

async function acknowledge(validation: WebPushValidation): Promise<void> {
  const [, pending] = await Promise.all([
    record('WEBPUSH_VALIDATION'),
    pendingPushActivations(Date.now()),
  ]);
  const acked = await Promise.all(pending.map((userId) => acknowledgeFor(userId, validation)));
  if (acked.includes(true)) return;

  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: 'sable:webpush-ack',
      appId: validation.app_id,
      ackToken: validation.ack_token,
    });
  }
}

async function acknowledgeFor(userId: string, validation: WebPushValidation): Promise<boolean> {
  const session = await pushSession(userId);
  if (!session) return false;
  const acked = await acknowledgeWebPusher(session, validation, (input, init) =>
    fetch(input, init)
  );
  if (acked) await settlePushActivation(userId);
  return acked;
}

worker.addEventListener('message', (event) => {
  const message = event.data as { type?: unknown } | undefined;
  if (message?.type === 'sable:skip-waiting')
    event.waitUntil(watchWorkerOperation('skip-waiting', worker.skipWaiting()));
  if (message?.type === 'sable:share-take')
    event.waitUntil(watchWorkerOperation('share-take', handShares()));
  if (message?.type === 'sable:version') event.ports[0]?.postMessage(version);
});

interface StashedShare {
  serverUserId: string | null;
  text: string;
  files: File[];
}

const shareAction = `${resolve('/(app)').replace(/\/$/, '')}/share`;
const shares = new Map<string, StashedShare>();

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== shareAction) return;
  event.respondWith(watchWorkerOperation('share', stashShare(event)));
});

const SHARE_HOLD_MS = 15_000;

async function stashShare(event: FetchEvent): Promise<Response> {
  const serverUserId = import.meta.env.VITE_SABLE_SERVER_URL ? await currentServerUser() : null;
  const form = await event.request.formData();
  const text = ['title', 'text', 'url']
    .map((field) => form.get(field))
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join('\n');
  const files = form.getAll('files').filter((value): value is File => value instanceof File);

  const id = crypto.randomUUID();
  shares.set(id, { serverUserId, text, files });
  event.waitUntil(watchWorkerOperation('share-hold', holdShare(id)));

  return Response.redirect(resolve('/(app)'), 303);
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
  for (const [id, share] of shares) {
    let client: Client | undefined;
    const serverUserId = share.serverUserId;
    if (serverUserId === null) {
      client = clients.at(0);
    } else if ((await currentServerUser()) === serverUserId) {
      const matches = await Promise.all(
        clients.map((candidate) => clientHasServerIdentity(candidate, serverUserId))
      );
      client = clients.find((_, index) => matches[index]);
    }
    if (!client || shares.get(id) !== share) continue;
    shares.delete(id);
    client.postMessage({
      type: 'sable:share',
      serverUserId: share.serverUserId,
      text: share.text,
      files: share.files,
    });
  }
}

function record(outcome: string, trace: Omit<PushHistoryEntry, 'at' | 'outcome'> = {}) {
  return recordPush({ at: Date.now(), outcome, ...trace });
}

async function present(
  pushed: PushNotification | undefined,
  serverUserId: string | null
): Promise<void> {
  if (!pushed) {
    await record('INVALID_PAYLOAD');
    return;
  }
  const trace = pushTrace(pushed);
  if (isDiagnosticPush(pushed)) {
    await record('DIAGNOSTIC_RECEIVED', trace);
    return;
  }

  if (pushed.unread !== null && 'setAppBadge' in navigator) {
    await navigator.setAppBadge(pushed.unread).catch((error: unknown) => {
      console.debug('[sable service-worker] app badge not set', error);
    });
  }
  if (pushed.unread === 0 && pushed.event_id === null && (await pushContentPolicy()).clearOnRead) {
    await closeRead(pushed);
    await record('READ_DISMISSED', trace);
    return;
  }

  if (await focused()) {
    await record('APP_FOCUSED', trace);
    return;
  }
  const fetched =
    namesOnlyItsEvent(pushed) || isRtcInvite(pushed) || pushed.type === 'm.room.encrypted';
  const payload: CompletedPushNotification | null = fetched ? await fetchEvent(pushed) : pushed;
  if (!payload) {
    await record('DISCARDED', trace);
    return;
  }
  if (payload.unread === 0 && !isRtcInvite(payload) && (await pushContentPolicy()).clearOnRead) {
    await closeRead(payload);
    await record('READ_DISMISSED', trace);
    return;
  }
  if (fetched) await record(payload.type ? 'FETCHED' : 'FETCH_FAILED', trace);
  if (silencedByRoomMode(payload, await roomMode(payload.room_id ?? ''))) {
    await record('ROOM_MODE_SILENCED', trace);
    return;
  }

  const policy = await pushContentPolicy();
  const encrypted = payload.type === 'm.room.encrypted' || payload.decrypted;
  const showContent = policy.content && (!encrypted || policy.encryptedContent);
  const showing = pushAlert(payload, await roomName(payload.room_id ?? ''), showContent);
  if (!showing) {
    await record('BADGE_ONLY', trace);
    return;
  }
  if (
    policy.quietWhenActiveElsewhere &&
    !showing.ring &&
    !showing.invite &&
    (await inUseElsewhere(payload.user_id ?? undefined))
  ) {
    await record('ACTIVE_ELSEWHERE', trace);
    return;
  }

  const alertedAt = await alertedAtFor(showing.room_id, payload.user_id ?? undefined);
  const now = Date.now();
  const renotify =
    !policy.notifyOnce || alertedAt === undefined || payload.noisy || !alertCooling(alertedAt, now);
  const tag = showing.event_id === null ? showing.tag : `${showing.tag}:${showing.event_id}`;

  const options: NotificationOptions & {
    renotify?: boolean;
    timestamp?: number;
    actions?: { action: string; title: string }[];
  } = {
    body: showing.body,
    tag,
    renotify,
    silent: !renotify,
    icon: payload.icon ?? favicon,
    badge: favicon,
    timestamp: now,
    data: {
      roomId: showing.room_id,
      userId: payload.user_id ?? undefined,
      eventId: showing.event_id,
      invite: showing.invite,
      call: isRtcInvite(payload),
      callEventId: isRtcInvite(payload) ? showing.event_id : undefined,
      callExpiresAtMs: isRtcInvite(payload) ? (payload.callExpiresAtMs ?? now + 120000) : undefined,
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

  if (serverUserId && (await currentServerUser()) !== serverUserId) {
    await showFallback();
    return;
  }
  await worker.registration.showNotification(showing.title, options);
  await record('POSTED', trace);
}

async function inUseElsewhere(userId: string | undefined): Promise<boolean> {
  const session = await pushSession(userId);
  if (!session?.deviceId) return false;
  const content = await fetchDeviceActivity({
    session,
    fetch: (input, init) => fetch(input, init),
  });
  return content !== null && activeElsewhere(content, session.deviceId, Date.now());
}

const FETCH_DEADLINE_MS = 10_000;

async function fetchEvent(payload: PushNotification): Promise<CompletedPushNotification | null> {
  const session = await pushSession(payload.user_id ?? undefined);
  if (!session) return isRtcInvite(payload) ? null : payload;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CompletedPushNotification | null>((settle) => {
    timer = setTimeout(() => {
      settle(isRtcInvite(payload) ? null : payload);
    }, FETCH_DEADLINE_MS);
  });
  const completed = completePushPayload(
    { ...payload, user_id: session.userId },
    {
      session,
      fetch: (input, init) => fetch(input, init),
      roomName,
      decrypt: (roomId, eventId) => decryptInTab(roomId, eventId, session.userId),
    }
  );
  try {
    return await Promise.race([completed, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const DECRYPT_TIMEOUT_MS = 5000;

async function decryptInTab(
  roomId: string,
  eventId: string,
  userId: string
): Promise<PushFetchView | null> {
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const serverUserId = import.meta.env.VITE_SABLE_SERVER_URL ? await currentServerUser() : null;
  for (const client of clients) {
    if (serverUserId !== null && !(await clientHasServerIdentity(client, serverUserId))) continue;
    const answer = await new Promise<PushFetchView | null>((settle) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        settle(null);
      }, DECRYPT_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        settle(readPushFetch(event.data));
      };
      client.postMessage({ type: 'sable:push-event', roomId, eventId, userId, serverUserId }, [
        channel.port2,
      ]);
    });
    if (answer !== null) return answer;
  }
  return null;
}

async function closeRead(pushed: PushNotification): Promise<void> {
  if (!('getNotifications' in worker.registration)) return;
  const userId = pushed.user_id;
  for (const notification of await worker.registration.getNotifications()) {
    const data = notification.data as PresentedAlertData | undefined;
    if (isRingingCall(data)) continue;
    if (pushed.room_id !== null && data?.roomId !== pushed.room_id) continue;
    if (userId !== null && typeof data?.userId === 'string' && data.userId !== userId) {
      continue;
    }
    notification.close();
  }
}

async function reconcileRead(pushed: PushNotification): Promise<boolean> {
  if (!('getNotifications' in worker.registration)) return false;
  const session = await pushSession(pushed.user_id ?? undefined);
  if (!session) return false;
  const userId = pushed.user_id ?? session.userId;
  const notifications = await worker.registration.getNotifications();
  const rooms = roomsToReconcile(notifications, userId, pushed.room_id);
  const read = await readPushRooms({ session, fetch: (input, init) => fetch(input, init) }, rooms);
  if (read === null) return false;
  const readRooms = new Set(read);
  let closed = false;
  for (const notification of notifications) {
    const data = notification.data as PresentedAlertData | undefined;
    if (isRingingCall(data)) continue;
    if (data?.userId !== userId || typeof data.roomId !== 'string' || !readRooms.has(data.roomId)) {
      continue;
    }
    notification.close();
    closed = true;
  }
  return closed;
}

async function focused(): Promise<boolean> {
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some((client) => client.focused);
}

async function alertedAtFor(
  roomId: string,
  userId: string | undefined
): Promise<number | undefined> {
  if (!('getNotifications' in worker.registration)) return undefined;
  let alertedAt: number | undefined;
  for (const notification of await worker.registration.getNotifications()) {
    const data = notification.data as
      | { roomId?: unknown; userId?: unknown; alertedAt?: unknown }
      | undefined;
    if (data?.roomId !== roomId) continue;
    if (userId !== undefined && typeof data.userId === 'string' && data.userId !== userId) continue;
    if (typeof data.alertedAt !== 'number') continue;
    if (alertedAt === undefined || data.alertedAt > alertedAt) alertedAt = data.alertedAt;
  }
  return alertedAt;
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
    roomId === undefined ? resolve('/(app)') : notificationPermalink(roomId, eventId, userId)
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
