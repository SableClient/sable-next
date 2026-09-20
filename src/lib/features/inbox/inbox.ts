import type { BookmarkView, NotificationModeView, RoomSummary } from '#src/generated/protocol';

export type NotificationFilter = 'all' | 'mentions' | 'direct';

export function parseFilter(value: string | null): NotificationFilter {
  return value === 'mentions' || value === 'direct' ? value : 'all';
}

type NotificationModeResolver = (roomId: string) => NotificationModeView | null;
const unknownMode: NotificationModeResolver = () => null;

export function notificationCount(
  room: RoomSummary,
  mode: NotificationModeView | null = null
): number {
  if (mode === 'mute') return 0;
  if (mode === 'mentions') return room.highlight;
  return mode === 'all' || room.is_direct ? Math.max(room.unread, room.highlight) : room.highlight;
}

function matchesFilter(
  room: RoomSummary,
  filter: NotificationFilter,
  mode: NotificationModeView | null
): boolean {
  if (mode === 'mute') return false;
  switch (filter) {
    case 'direct':
      return room.is_direct && (notificationCount(room, mode) > 0 || room.marked_unread);
    case 'mentions':
      return room.highlight > 0;
    default:
      return notificationCount(room, mode) > 0 || room.marked_unread;
  }
}

function byRecency(left: RoomSummary, right: RoomSummary): number {
  return (right.latest_event?.timestamp ?? 0) - (left.latest_event?.timestamp ?? 0);
}

export function notifications(
  rooms: readonly RoomSummary[],
  filter: NotificationFilter,
  mode: NotificationModeResolver = unknownMode
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
  mode: NotificationModeResolver = unknownMode
): number {
  return notifications(rooms, 'all', mode).reduce(
    (total, room) => total + notificationCount(room, mode(room.room_id)),
    0
  );
}

export function hasMarkedUnread(
  rooms: readonly RoomSummary[],
  mode: NotificationModeResolver = unknownMode
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
