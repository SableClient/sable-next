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
  const said = notification.content?.body;
  if (showContent && !invites(notification) && said !== undefined && said !== '') {
    return { sender, body: said };
  }
  return { sender: null, body: body(notification, sender, showContent) };
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
