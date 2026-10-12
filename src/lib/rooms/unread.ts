import type { NotificationModeView, RoomSummary } from '#src/generated/protocol';

import type { UnreadCount } from './spaces.js';

export type RoomUnread = (room: RoomSummary) => UnreadCount;

export const NO_UNREAD: UnreadCount = { unread: 0, highlight: 0, marked: false };

export type BadgeNotificationMode = 'all' | 'mentions' | 'quiet';

export const roomUnread: RoomUnread = (room) => room.counts;

export const roomNotifications: RoomUnread = ({ counts }) => ({
  unread: counts.notifying,
  highlight: counts.highlight,
  marked: counts.marked,
});

export function quietUnread(count: UnreadCount): UnreadCount {
  return { ...count, unread: count.highlight, notifying: 0 };
}

function softUnread(count: UnreadCount): UnreadCount {
  return { ...count, notifying: 0 };
}

function loudUnread(count: UnreadCount): UnreadCount {
  return { ...count, notifying: Math.max(count.notifying ?? 0, count.unread) };
}

export function badgeModeFor(
  room: Pick<RoomSummary, 'is_direct'>,
  roomOverride: NotificationModeView | null,
  defaults: { direct: BadgeNotificationMode; group: BadgeNotificationMode }
): BadgeNotificationMode | 'mute' {
  if (roomOverride === 'mute') return 'mute';
  if (roomOverride === 'all' || roomOverride === 'mentions') return roomOverride;
  return room.is_direct ? defaults.direct : defaults.group;
}

export function applyBadgeMode(
  count: UnreadCount,
  mode: BadgeNotificationMode | 'mute'
): UnreadCount {
  if (mode === 'mute') return count;
  if (mode === 'quiet') return quietUnread(count);
  if (mode === 'mentions') return softUnread(count);
  return loudUnread(count);
}

export function hasUnread(count: UnreadCount): boolean {
  return count.unread > 0 || count.highlight > 0 || (count.marked ?? false);
}
