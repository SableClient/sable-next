import type { NotificationModeView, RoomSummary } from '#src/generated/protocol';

import type { UnreadCount } from './spaces.js';

export type NotificationModeResolver = (roomId: string) => NotificationModeView | null;

export const UNRESOLVED_MODE: NotificationModeResolver = () => null;

export type RoomUnread = (room: RoomSummary) => UnreadCount;

export const NO_UNREAD: UnreadCount = { unread: 0, highlight: 0, marked: false };

export function roomUnread(
  room: RoomSummary,
  mode: NotificationModeView | null = null
): UnreadCount {
  const marked = room.marked_unread;

  if (mode === 'mute') return { unread: 0, highlight: 0, marked };
  if (mode === 'mentions') {
    return { unread: room.highlight, highlight: room.highlight, marked };
  }
  return { unread: Math.max(room.unread, room.highlight), highlight: room.highlight, marked };
}

export function hasUnread(count: UnreadCount): boolean {
  return count.unread > 0 || count.highlight > 0 || (count.marked ?? false);
}
