import { uint8ArrayToBase64 } from 'uint8array-extras';

import type { PushFetchView } from '#src/generated/protocol';

import { isRecord } from '#lib/guards.js';

import { pushContent, type PushPayload } from './push-payload';
import type { PushSession } from './room-names';

const REQUEST_TIMEOUT_MS = 8000;
const AVATAR_SIZE = 96;

export interface PushFetcher {
  session: PushSession;
  fetch: typeof fetch;
  roomName: (roomId: string) => Promise<string | null>;
  decrypt: (roomId: string, eventId: string) => Promise<PushFetchView | null>;
}

export function namesOnlyItsEvent(payload: PushPayload): boolean {
  const notification = payload.notification;
  return (
    notification?.room_id !== undefined &&
    notification.event_id !== undefined &&
    notification.type === undefined
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
    },
  };
}

export async function completePushPayload(
  payload: PushPayload,
  fetcher: PushFetcher
): Promise<PushPayload | null> {
  const notification = payload.notification;
  const roomId = notification?.room_id;
  const eventId = notification?.event_id;
  if (notification === undefined || roomId === undefined || eventId === undefined) return payload;

  const room = `rooms/${encodeURIComponent(roomId)}`;
  const event = await get(fetcher, `${room}/event/${encodeURIComponent(eventId)}`);
  if (!isRecord(event) || typeof event.type !== 'string') return payload;
  const sender = text(event.sender);

  const [member, storedName, stateName, roomAvatar] = await Promise.all([
    sender === undefined
      ? null
      : get(fetcher, `${room}/state/m.room.member/${encodeURIComponent(sender)}`),
    fetcher.roomName(roomId),
    get(fetcher, `${room}/state/m.room.name/`),
    get(fetcher, `${room}/state/m.room.avatar/`),
  ]);
  const senderName = text(isRecord(member) ? member.displayname : undefined) ?? sender;
  const avatar =
    text(isRecord(roomAvatar) ? roomAvatar.url : undefined) ??
    text(isRecord(member) ? member.avatar_url : undefined);

  let completed: NonNullable<PushPayload['notification']> = {
    ...notification,
    type: event.type,
    content: pushContent(event.content),
    sender_display_name: senderName,
    room_name: storedName ?? text(isRecord(stateName) ? stateName.name : undefined) ?? senderName,
    icon: avatar === undefined ? undefined : await thumbnail(fetcher, avatar),
  };

  if (event.type === 'm.room.encrypted') {
    const decrypted = await fetcher.decrypt(roomId, eventId);
    if (decrypted?.kind === 'discard') return null;
    if (decrypted?.kind === 'event') {
      completed = {
        ...completed,
        type: decrypted.event.type,
        content: pushContent(decrypted.event.content),
        sender_display_name: decrypted.event.sender_display_name ?? senderName,
        room_name: completed.room_name ?? text(decrypted.event.room_name),
        decrypted: true,
      };
    }
  }

  return { notification: completed };
}

async function get(fetcher: PushFetcher, path: string): Promise<unknown> {
  try {
    const response = await fetcher.fetch(
      `${fetcher.session.homeserver.replace(/\/$/, '')}/_matrix/client/v3/${path}`,
      {
        headers: { Authorization: `Bearer ${fetcher.session.accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    return response.ok ? await response.json() : null;
  } catch {
    return null;
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
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
