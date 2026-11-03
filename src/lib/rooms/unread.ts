import type { RoomListItemView, RoomUnreadView } from '#src/generated/protocol';

export type UnreadCount = Pick<RoomUnreadView, 'unread' | 'highlight'> &
  Partial<Pick<RoomUnreadView, 'marked' | 'notifying'>>;

export type RoomUnread = (room: RoomListItemView) => UnreadCount;

export const NO_UNREAD: UnreadCount = { unread: 0, highlight: 0, marked: false };

export type BadgeNotificationMode = 'all' | 'mentions' | 'quiet';

export const roomUnread: RoomUnread = (room) => room.counts;

export const roomNotifications: RoomUnread = ({ counts }) => ({
  unread: counts.notifying,
  highlight: counts.highlight,
  marked: counts.marked,
});

export function hasUnread(count: UnreadCount): boolean {
  return count.unread > 0 || count.highlight > 0 || (count.marked ?? false);
}
