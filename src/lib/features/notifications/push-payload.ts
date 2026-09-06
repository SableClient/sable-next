import type { ConversationLine } from './conversation';
import { roomTag } from './tag';

/** With `event_id_only` the payload holds a room, an event and counts, and
    nothing else, so none of this can be relied on. */
export type PushPayload = {
  notification?: {
    room_id?: string;
    event_id?: string;
    user_id?: string;
    room_name?: string;
    sender_display_name?: string;
    type?: string;
    content?: { body?: string; membership?: string };
    counts?: { unread?: number };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parsePushPayload(raw: string | undefined): PushPayload | null {
  if (!raw) return null;
  try {
    const envelope: unknown = JSON.parse(raw);
    if (!isRecord(envelope)) return null;
    let notification: unknown =
      envelope.notification === undefined ? envelope : envelope.notification;
    if (typeof notification === 'string') notification = JSON.parse(notification);
    if (!isRecord(notification)) return null;
    const recipients = new Set<string>();
    const addRecipient = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) recipients.add(value.trim());
    };
    addRecipient(envelope.user_id);
    addRecipient(notification.user_id);
    if (Array.isArray(notification.devices)) {
      for (const device of notification.devices) {
        if (!isRecord(device) || !isRecord(device.data)) continue;
        addRecipient(device.data.user_id);
        if (isRecord(device.data.default_payload))
          addRecipient(device.data.default_payload.user_id);
      }
    }
    if (recipients.size > 1) return null;
    const [userId] = recipients;
    const content = isRecord(notification.content) ? notification.content : {};
    const counts = isRecord(notification.counts) ? notification.counts : {};
    const unread =
      typeof counts.unread === 'number' && Number.isSafeInteger(counts.unread) && counts.unread >= 0
        ? counts.unread
        : undefined;
    return {
      notification: {
        user_id: userId,
        room_id: text(notification.room_id),
        event_id: text(notification.event_id),
        room_name: text(notification.room_name),
        sender_display_name: text(notification.sender_display_name),
        type: text(notification.type),
        content: { body: text(content.body), membership: text(content.membership) },
        counts: { unread },
      },
    };
  } catch {
    return null;
  }
}

export type PushAlert = {
  title: string;
  body: string;
  line: ConversationLine;
  tag: string;
  roomId: string;
  eventId: string | null;
};

export function unreadCount(payload: PushPayload): number | null {
  return payload.notification?.counts?.unread ?? null;
}

/** `null` for a push that only carries counts, which is a badge update and not
    something to put on screen. */
export function alert(
  payload: PushPayload,
  roomName: string | null,
  showContent: boolean
): PushAlert | null {
  const notification = payload.notification;
  const roomId = notification?.room_id;
  if (!notification || roomId === undefined) return null;

  const sender = notification.sender_display_name ?? null;

  return {
    title: notification.room_name ?? roomName ?? 'Sable',
    body: body(notification, sender, showContent),
    line: line(notification, sender, showContent),
    tag: roomTag(notification.user_id, roomId),
    roomId,
    eventId: notification.event_id ?? null,
  };
}

function line(
  notification: NonNullable<PushPayload['notification']>,
  sender: string | null,
  showContent: boolean
): ConversationLine {
  const eventId = notification.event_id ?? null;
  const said = notification.content?.body;
  if (showContent && !invites(notification) && said !== undefined && said !== '') {
    return { sender, body: said, eventId };
  }
  return { sender: null, body: body(notification, sender, showContent), eventId };
}

function invites(notification: NonNullable<PushPayload['notification']>): boolean {
  return notification.type === 'm.room.member' && notification.content?.membership === 'invite';
}

function body(
  notification: NonNullable<PushPayload['notification']>,
  sender: string | null,
  showContent: boolean
): string {
  if (invites(notification)) {
    return sender === null ? 'Invited you' : `${sender} invited you`;
  }

  const said = notification.content?.body;
  if (showContent && said !== undefined && said !== '') {
    return sender === null ? said : `${sender}: ${said}`;
  }

  return sender === null ? 'New message' : `New message from ${sender}`;
}
