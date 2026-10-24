import type { RoomListItemView, RoomUnreadView } from '#src/generated/protocol';

export type UnreadCount = RoomUnreadView;

export type RoomUnread = (room: RoomListItemView) => UnreadCount;

export const NO_UNREAD: UnreadCount = { unread: 0, highlight: 0, marked: false, notifying: 0 };

export type { BadgeNotificationMode } from '#src/generated/protocol';

export const roomUnread: RoomUnread = (room) => room.counts;

export const roomNotifications: RoomUnread = ({ counts }) => ({
  unread: counts.notifying,
  highlight: counts.highlight,
  marked: counts.marked,
  notifying: counts.notifying,
});

export function hasUnread(count: UnreadCount): boolean {
  return count.unread > 0 || count.highlight > 0 || count.marked;
}
