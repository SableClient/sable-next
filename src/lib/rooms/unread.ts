import type { NotificationModeView, RoomSummary } from '#src/generated/protocol';

import type { UnreadCount } from './spaces.js';

export type NotificationModeResolver = (roomId: string) => NotificationModeView | null;

export const UNRESOLVED_MODE: NotificationModeResolver = () => null;

export type RoomUnread = (room: RoomSummary) => UnreadCount;

export const NO_UNREAD: UnreadCount = { unread: 0, highlight: 0, marked: false };

function counts(room: RoomSummary): UnreadCount {
  return {
    unread: room.unread || 0,
    highlight: room.highlight || 0,
    marked: room.marked_unread,
  };
}

export function roomUnread(
  room: RoomSummary,
  mode: NotificationModeView | null = null
): UnreadCount {
  const { unread, highlight, marked } = counts(room);
  const notifying = roomNotifications(room, mode).unread;

  if (mode === 'mute') return { unread: 0, highlight: 0, marked, notifying };
  return { unread: Math.max(unread, highlight), highlight, marked, notifying };
}

export function roomNotifications(
  room: RoomSummary,
  mode: NotificationModeView | null = null
): UnreadCount {
  const { unread, highlight, marked } = counts(room);

  if (mode === 'mute') return { unread: 0, highlight: 0, marked };
  if (mode === 'mentions') return { unread: highlight, highlight, marked };
  return { unread: Math.max(unread, highlight), highlight, marked };
}

export function hasUnread(count: UnreadCount): boolean {
  return count.unread > 0 || count.highlight > 0 || (count.marked ?? false);
}
