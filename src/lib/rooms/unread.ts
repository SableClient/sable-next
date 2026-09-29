import type { NotificationModeView, RoomSummary } from '#src/generated/protocol';

import type { UnreadCount } from './spaces.js';

export type NotificationModeResolver = (roomId: string) => NotificationModeView | null;

export const UNRESOLVED_MODE: NotificationModeResolver = () => null;

export type RoomUnread = (room: RoomSummary) => UnreadCount;

export const NO_UNREAD: UnreadCount = { unread: 0, highlight: 0, marked: false };

export type BadgeNotificationMode = 'all' | 'mentions';

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
  const { highlight, marked } = counts(room);

  if (mode === 'mute') return { unread: 0, highlight: 0, marked };
  return { unread: Math.max(room.notifying || 0, highlight), highlight, marked };
}

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
  if (mode === 'mentions') return softUnread(count);
  return loudUnread(count);
}

export function hasUnread(count: UnreadCount): boolean {
  return count.unread > 0 || count.highlight > 0 || (count.marked ?? false);
}
