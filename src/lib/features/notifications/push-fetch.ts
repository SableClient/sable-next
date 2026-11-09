import { uint8ArrayToBase64 } from 'uint8array-extras';

import type { PushFetchView, WebPushValidation } from '#src/generated/protocol';

import { isRecord } from '#lib/guards.js';
import { validateRtcInviteSnapshot, visibleName } from '#lib/model/model.js';

import { pushContent, type PushNotification } from '#lib/notifications/push-payload.js';
import type { PushSession } from '#lib/notifications/room-names.js';
import { sleep } from '#lib/sleep.js';

const REQUEST_TIMEOUT_MS = 8000;
const READ_ROOMS_TIMEOUT_MS = 5000;
const AVATAR_SIZE = 96;

export interface PushFetcher {
  session: PushSession;
  fetch: typeof fetch;
  roomName: (roomId: string) => Promise<string | null>;
  decrypt: (roomId: string, eventId: string) => Promise<PushFetchView | null>;
}

export type CompletedPushNotification = PushNotification & { callExpiresAtMs?: number };

export function isRtcInvite(notification: Pick<PushNotification, 'type'>): boolean {
  return (
    notification.type === 'm.rtc.invite' ||
    notification.type === 'm.rtc.notification' ||
    notification.type === 'org.matrix.msc4075.rtc.notification'
  );
}

export function namesOnlyItsEvent(notification: PushNotification): boolean {
  return (
    notification.room_id !== null && notification.event_id !== null && notification.type === null
  );
}

export function readPushFetch(value: unknown): PushFetchView | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'discard') return { kind: 'discard' };
  if (value.kind !== 'event' || !isRecord(value.event)) return null;
  const event = value.event;
  if (typeof event.type !== 'string' || typeof event.sender !== 'string') return null;
  return {
    kind: 'event',
    event: {
      type: event.type,
      content: event.content ?? null,
      sender: event.sender,
      sender_display_name: text(event.sender_display_name) ?? null,
      room_name: text(event.room_name) ?? '',
      room_avatar_url: text(event.room_avatar_url) ?? null,
      encrypted: event.encrypted === true,
      noisy: event.noisy === true,
    },
  };
}

export async function completePushPayload(
  notification: PushNotification,
  fetcher: PushFetcher
): Promise<CompletedPushNotification | null> {
  const roomId = notification.room_id;
  const eventId = notification.event_id;
  if (roomId === null || eventId === null) return isRtcInvite(notification) ? null : notification;

  const room = `rooms/${encodeURIComponent(roomId)}`;
  const fetched = await request(fetcher, `${room}/event/${encodeURIComponent(eventId)}`);
  if (fetched.status === 403 || fetched.status === 404) {
    if (isRtcInvite(notification)) return null;
    return {
      ...notification,
      type: 'm.room.member',
      content: { body: null, membership: 'invite', notification_type: null },
      room_name: await fetcher.roomName(roomId),
    };
  }
  const raw = fetched.body;
  if (!isRecord(raw) || typeof raw.type !== 'string')
    return isRtcInvite(notification) ? null : notification;
  let event: Record<string, unknown> = raw;
  if (isRtcInvite({ type: raw.type })) {
    const prepared = await prepareRtcInvite(fetcher, roomId, eventId, event);
    if (prepared === null) return null;
    event = prepared;
  }
  const sender = text(event.sender);

  const [member, storedName, stateName, roomAvatar] = await Promise.all([
    sender === undefined
      ? null
      : get(fetcher, `${room}/state/m.room.member/${encodeURIComponent(sender)}`),
    fetcher.roomName(roomId),
    get(fetcher, `${room}/state/m.room.name/`),
    get(fetcher, `${room}/state/m.room.avatar/`),
  ]);
  const senderName =
    visibleName(text(isRecord(member) ? member.displayname : undefined) ?? '') ?? sender;
  const avatar =
    text(isRecord(roomAvatar) ? roomAvatar.url : undefined) ??
    text(isRecord(member) ? member.avatar_url : undefined);

  let completed: CompletedPushNotification = {
    ...notification,
    type: text(event.type) ?? null,
    content: pushContent(event.content),
    sender_display_name: senderName ?? null,
    room_name:
      storedName ?? text(isRecord(stateName) ? stateName.name : undefined) ?? senderName ?? null,
    icon: avatar === undefined ? null : ((await thumbnail(fetcher, avatar)) ?? null),
    callExpiresAtMs: isRtcInvite({ type: text(event.type) ?? null })
      ? rtcExpiry(event.content)
      : undefined,
  };

  if (event.type === 'm.room.encrypted') {
    const decrypted = await fetcher.decrypt(roomId, eventId);
    if (decrypted?.kind === 'discard') return null;
    if (decrypted?.kind === 'event') {
      completed = {
        ...completed,
        type: decrypted.event.type,
        content: pushContent(decrypted.event.content),
        sender_display_name: decrypted.event.sender_display_name ?? senderName ?? null,
        room_name: completed.room_name ?? text(decrypted.event.room_name) ?? null,
        decrypted: true,
        callExpiresAtMs: isRtcInvite({ type: decrypted.event.type })
          ? rtcExpiry(decrypted.event.content)
          : undefined,
      };
    }
  }

  return completed;
}

function rtcExpiry(content: unknown): number | undefined {
  if (
    !isRecord(content) ||
    typeof content.sender_ts !== 'number' ||
    typeof content.lifetime !== 'number'
  )
    return undefined;
  return content.sender_ts + content.lifetime;
}

async function prepareRtcInvite(
  fetcher: PushFetcher,
  roomId: string,
  eventId: string,
  event: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const fromApp = await fetcher.decrypt(roomId, eventId);
  if (fromApp?.kind === 'discard') return null;
  if (fromApp?.kind === 'event')
    return { ...event, type: fromApp.event.type, content: fromApp.event.content };

  const content = isRecord(event.content) ? event.content : {};
  const legacy =
    event.type !== 'm.rtc.invite' &&
    event.sticky === undefined &&
    event.msc4354_sticky === undefined &&
    (content.notification_type === 'ring' || content.notification_type === 'notification');
  let events: unknown[];
  if (legacy) {
    const state = await get(fetcher, `rooms/${encodeURIComponent(roomId)}/state`);
    if (!Array.isArray(state)) return null;
    events = state;
  } else {
    const result = await request(
      fetcher,
      '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?timeout=0',
      {
        conn_id: `push-${crypto.randomUUID().slice(0, 8)}`,
        room_subscriptions: {
          [roomId]: {
            timeline_limit: 0,
            required_state: [
              ['m.rtc.slot', '*'],
              ['org.matrix.msc4143.rtc.slot', '*'],
              ['m.room.power_levels', ''],
              ['m.room.create', ''],
              ['org.matrix.msc3401.call.member', '*'],
              ['m.call.member', '*'],
            ],
          },
        },
        extensions: { 'org.matrix.msc4354.sticky_events': { enabled: true } },
      }
    );
    if (!isRecord(result.body)) return null;
    const rooms = isRecord(result.body.rooms) ? result.body.rooms : {};
    const room = isRecord(rooms[roomId]) ? rooms[roomId] : {};
    const extensions = isRecord(result.body.extensions) ? result.body.extensions : {};
    const sticky = extensions['org.matrix.msc4354.sticky_events'] ?? extensions.sticky_events;
    const stickyRooms = isRecord(sticky) && isRecord(sticky.rooms) ? sticky.rooms : {};
    const stickyRoom = isRecord(stickyRooms[roomId]) ? stickyRooms[roomId] : {};
    const state: unknown[] = Array.isArray(room.required_state) ? room.required_state : [];
    const stickyEvents: unknown[] = Array.isArray(stickyRoom.events) ? stickyRoom.events : [];
    events = [...state, ...stickyEvents];
  }
  const valid = validateRtcInviteSnapshot(event, events, fetcher.session.userId, Date.now());
  if (valid === null) return null;
  const direct = await get(
    fetcher,
    `user/${encodeURIComponent(fetcher.session.userId)}/account_data/m.direct`
  );
  const modern = !legacy && (event.type === 'm.rtc.invite' || content.slot_id !== undefined);
  const mentions = isRecord(content['m.mentions']) ? content['m.mentions'] : {};
  const ring = modern
    ? (Array.isArray(mentions.user_ids) && mentions.user_ids.includes(fetcher.session.userId)) ||
      (isRecord(direct) &&
        Object.values(direct).some((rooms) => Array.isArray(rooms) && rooms.includes(roomId)))
    : content.notification_type === 'ring';
  const now = Date.now();
  const remaining = valid.expires_at_ms - now;
  if (remaining <= 0) return null;
  return {
    ...event,
    content: {
      ...content,
      notification_type: ring ? 'ring' : 'notification',
      sender_ts: now,
      lifetime: remaining,
      'm.call.intent': valid.has_video ? 'video' : 'audio',
      body: 'Call started',
    },
  };
}

export async function fetchDeviceActivity(
  fetcher: Pick<PushFetcher, 'session' | 'fetch'>
): Promise<unknown> {
  return get(
    fetcher,
    `user/${encodeURIComponent(fetcher.session.userId)}/account_data/moe.sable.device_activity`
  );
}

export async function readPushRooms(
  fetcher: Pick<PushFetcher, 'session' | 'fetch'>,
  roomIds: readonly string[]
): Promise<string[] | null> {
  if (roomIds.length === 0) return [];
  const filter = {
    room: {
      rooms: roomIds,
      timeline: { limit: 0 },
      state: { types: [] },
      ephemeral: { types: [] },
      account_data: { types: [] },
    },
    presence: { types: [] },
    account_data: { types: [] },
  };
  const query = new URLSearchParams({
    timeout: '0',
    set_presence: 'offline',
    filter: JSON.stringify(filter),
  });
  const { body } = await request(fetcher, `sync?${query}`, undefined, READ_ROOMS_TIMEOUT_MS);
  const join = isRecord(body) && isRecord(body.rooms) ? body.rooms.join : undefined;
  if (!isRecord(join)) return null;
  return roomIds.filter((roomId) => {
    const room = join[roomId];
    if (!isRecord(room)) return room === undefined;
    const unread = room.unread_notifications;
    const count = isRecord(unread) ? unread.notification_count : undefined;
    return count === undefined || count === 0;
  });
}

async function get(
  fetcher: Pick<PushFetcher, 'session' | 'fetch'>,
  path: string
): Promise<unknown> {
  return (await request(fetcher, path)).body;
}

async function request(
  fetcher: Pick<PushFetcher, 'session' | 'fetch'>,
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<{ status: number | null; body: unknown }> {
  try {
    const response = await fetcher.fetch(
      `${fetcher.session.homeserver.replace(/\/$/, '')}${path.startsWith('/') ? path : `/_matrix/client/v3/${path}`}`,
      {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          Authorization: `Bearer ${fetcher.session.accessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    return { status: response.status, body: response.ok ? await response.json() : null };
  } catch (error) {
    console.debug('[sable notifications] push request failed', path, error);
    return { status: null, body: null };
  }
}

const ACK_ATTEMPTS = 3;

export async function acknowledgeWebPusher(
  session: PushSession,
  validation: WebPushValidation,
  send: typeof fetch,
  pause: (ms: number) => Promise<void> = sleep
): Promise<boolean> {
  const url = `${session.homeserver.replace(/\/$/, '')}/_matrix/client/unstable/org.matrix.msc4174/pushers/ack`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await send(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ app_id: validation.app_id, ack_token: validation.ack_token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch (error) {
      console.debug('[sable notifications] web push ack failed', error);
    }
    if (attempt === ACK_ATTEMPTS) return false;
    await pause(1000 * attempt);
  }
}

async function thumbnail(fetcher: PushFetcher, mxc: string): Promise<string | undefined> {
  const media = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
  if (!media) return undefined;
  const [, server = '', mediaId = ''] = media;
  try {
    const response = await fetcher.fetch(
      `${fetcher.session.homeserver.replace(/\/$/, '')}/_matrix/client/v1/media/thumbnail/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}?width=${AVATAR_SIZE}&height=${AVATAR_SIZE}&method=crop`,
      {
        headers: { Authorization: `Bearer ${fetcher.session.accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) return undefined;
    const type = response.headers.get('content-type') ?? 'image/png';
    return `data:${type};base64,${uint8ArrayToBase64(new Uint8Array(await response.arrayBuffer()))}`;
  } catch (error) {
    console.debug('[sable notifications] push thumbnail failed', error);
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
