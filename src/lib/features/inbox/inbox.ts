import type { BookmarkView, NotificationModeView, RoomSummary } from '#src/generated/protocol';

import {
  hasUnread,
  type NotificationModeResolver,
  roomNotifications,
  UNRESOLVED_MODE,
} from '#lib/rooms/unread.js';

export type NotificationFilter = 'all' | 'mentions' | 'direct';

export function parseFilter(value: string | null): NotificationFilter {
  return value === 'mentions' || value === 'direct' ? value : 'all';
}

export function notificationCount(
  room: RoomSummary,
  mode: NotificationModeView | null = null
): number {
  return roomNotifications(room, mode).unread;
}

function matchesFilter(
  room: RoomSummary,
  filter: NotificationFilter,
  mode: NotificationModeView | null
): boolean {
  const count = roomNotifications(room, mode);

  switch (filter) {
    case 'direct':
      return room.is_direct && hasUnread(count);
    case 'mentions':
      return count.highlight > 0;
    default:
      return hasUnread(count);
  }
}

function byRecency(left: RoomSummary, right: RoomSummary): number {
  return (right.latest_event?.timestamp ?? 0) - (left.latest_event?.timestamp ?? 0);
}

export function notifications(
  rooms: readonly RoomSummary[],
  filter: NotificationFilter,
  mode: NotificationModeResolver = UNRESOLVED_MODE
): RoomSummary[] {
  return rooms
    .filter(
      (room) =>
        room.state === 'joined' && !room.is_space && matchesFilter(room, filter, mode(room.room_id))
    )
    .sort(byRecency);
}

export function countNotifications(
  rooms: readonly RoomSummary[],
  mode: NotificationModeResolver = UNRESOLVED_MODE
): number {
  return notifications(rooms, 'all', mode).reduce(
    (total, room) => total + notificationCount(room, mode(room.room_id)),
    0
  );
}

export function hasMarkedUnread(
  rooms: readonly RoomSummary[],
  mode: NotificationModeResolver = UNRESOLVED_MODE
): boolean {
  return notifications(rooms, 'all', mode).some((room) => room.marked_unread);
}

export function pendingInvites(rooms: readonly RoomSummary[]): RoomSummary[] {
  return rooms.filter((room) => room.state === 'invited').sort(byRecency);
}

export function countInvites(rooms: readonly RoomSummary[]): number {
  return rooms.reduce((total, room) => total + (room.state === 'invited' ? 1 : 0), 0);
}

export function inviter(room: RoomSummary): string | null {
  return room.latest_event?.sender ?? null;
}

export function senderName(userId: string): string {
  return userId.startsWith('@') ? (userId.slice(1).split(':')[0] ?? userId) : userId;
}

function matchesBookmarkQuery(bookmark: BookmarkView, needle: string): boolean {
  if (needle === '') return true;
  return (
    (bookmark.room_name?.toLowerCase().includes(needle) ?? false) ||
    (bookmark.sender !== null && senderName(bookmark.sender).toLowerCase().includes(needle)) ||
    (bookmark.body_preview?.toLowerCase().includes(needle) ?? false)
  );
}

export function filteredBookmarks(
  bookmarks: readonly BookmarkView[],
  query: string
): BookmarkView[] {
  const needle = query.trim().toLowerCase();
  return bookmarks
    .filter((bookmark) => matchesBookmarkQuery(bookmark, needle))
    .sort((left, right) => right.bookmarked_ts - left.bookmarked_ts);
}
