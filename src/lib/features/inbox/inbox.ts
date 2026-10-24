import type {
  BookmarkView,
  InboxFilter,
  InboxItemView,
  RoomListItemView,
} from '#src/generated/protocol';

import { formatTime } from '#lib/ui/date-time.js';
import { currentLocale } from '#lib/i18n.js';
import { hasUnread, type RoomUnread, roomUnread } from '#lib/rooms/unread.js';
import type { UnreadCount } from '#lib/rooms/unread.js';

export type NotificationFilter = InboxFilter;
export type InboxTab = 'notifications' | 'invites' | 'requests';

export const NOTIFICATION_GROUP_LIMIT = 5;

export interface NotificationGroup {
  roomId: string;
  latest: InboxItemView;
  items: InboxItemView[];
  hasMore: boolean;
  firstEventId: string;
  read: boolean;
  highlight: boolean;
}

export function groupNotifications(items: readonly InboxItemView[]): NotificationGroup[] {
  const rooms = new Map<string, InboxItemView[]>();
  for (const item of [...items].sort((left, right) => right.ts - left.ts)) {
    const group = rooms.get(item.room_id) ?? [];
    group.push(item);
    rooms.set(item.room_id, group);
  }
  return [...rooms].map(([roomId, entries]) => ({
    roomId,
    latest: entries[0],
    items: entries.slice(0, NOTIFICATION_GROUP_LIMIT),
    hasMore: entries.length > NOTIFICATION_GROUP_LIMIT,
    firstEventId: entries[entries.length - 1].event_id,
    read: entries.every((item) => item.read),
    highlight: entries.some((item) => item.highlight),
  }));
}

export function parseInboxTab(
  value: string | null,
  fallback: InboxTab = 'notifications'
): InboxTab {
  return value === 'notifications' || value === 'invites' || value === 'requests'
    ? value
    : fallback;
}

export function parseFilter(value: string | null): NotificationFilter {
  return value === 'mentions' || value === 'direct' ? value : 'all';
}

export function notificationCount(counts: UnreadCount): number {
  return Math.max(counts.notifying, counts.highlight);
}

function matchesFilter(
  room: RoomListItemView,
  filter: NotificationFilter,
  counts: UnreadCount
): boolean {
  switch (filter) {
    case 'direct':
      return room.is_direct && hasUnread(counts);
    case 'mentions':
      return counts.highlight > 0;
    default:
      return hasUnread(counts);
  }
}

function byRecency(left: RoomListItemView, right: RoomListItemView): number {
  return (right.latest_event?.timestamp ?? 0) - (left.latest_event?.timestamp ?? 0);
}

export function notifications(
  rooms: readonly RoomListItemView[],
  filter: NotificationFilter,
  unreadFor: RoomUnread = roomUnread
): RoomListItemView[] {
  return rooms
    .filter((room) => {
      if (room.state !== 'joined' || room.room_kind === 'space') return false;
      return matchesFilter(room, filter, unreadFor(room));
    })
    .sort(byRecency);
}

export function countNotifications(
  rooms: readonly RoomListItemView[],
  unreadFor: RoomUnread = roomUnread
): number {
  return rooms
    .filter((room) => room.state === 'joined' && room.room_kind !== 'space')
    .reduce((total, room) => total + notificationCount(unreadFor(room)), 0);
}

export function unlistedNotifications(
  rooms: readonly RoomListItemView[],
  filter: NotificationFilter,
  unreadFor: RoomUnread,
  listed: readonly string[]
): RoomListItemView[] {
  return notifications(rooms, filter, unreadFor).filter(
    (room) => notificationCount(unreadFor(room)) > 0 && !listed.includes(room.room_id)
  );
}

export function hasMarkedUnread(
  rooms: readonly RoomListItemView[],
  unreadFor: RoomUnread = roomUnread
): boolean {
  return rooms.some(
    (room) => room.state === 'joined' && room.room_kind !== 'space' && unreadFor(room).marked
  );
}

export function backfillSignal(rooms: readonly RoomListItemView[]): string {
  return JSON.stringify(
    rooms
      .filter((room) => room.unread > 0 || room.notifying > 0 || room.highlight > 0)
      .map((room) => [
        room.room_id,
        room.unread,
        room.notifying,
        room.highlight,
        room.latest_event?.event_id,
      ])
  );
}

export function pendingInvites(rooms: readonly RoomListItemView[]): RoomListItemView[] {
  return rooms.filter((room) => room.state === 'invited').sort(byRecency);
}

export function countInvites(rooms: readonly RoomListItemView[]): number {
  return rooms.reduce((total, room) => total + (room.state === 'invited' ? 1 : 0), 0);
}

export function inviter(room: RoomListItemView): string | null {
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

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatCompactTimestamp(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const days = Math.round((startOfDay(today) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return formatTime(timestamp);
  if (days < 7) return date.toLocaleDateString(currentLocale(), { weekday: 'short' });
  return date.toLocaleDateString(currentLocale(), {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function focusRowAt(
  section: HTMLElement | undefined,
  heading: HTMLElement | undefined,
  index: number
): void {
  const rows = section?.querySelectorAll<HTMLElement>('a.row');
  const target = rows?.item(Math.min(index, rows.length - 1)) ?? heading;
  target?.focus();
}
