import type { RoomSummary } from '@/generated/RoomSummary';

export type NotificationFilter = 'all' | 'mentions' | 'direct';

export function parseFilter(value: string | null): NotificationFilter {
  return value === 'mentions' || value === 'direct' ? value : 'all';
}

export function notificationCount(room: RoomSummary): number {
  return room.is_direct ? room.unread : room.highlight;
}

function matchesFilter(room: RoomSummary, filter: NotificationFilter): boolean {
  switch (filter) {
    case 'direct':
      return room.is_direct && room.unread > 0;
    case 'mentions':
      return room.highlight > 0;
    default:
      return notificationCount(room) > 0;
  }
}

function byRecency(left: RoomSummary, right: RoomSummary): number {
  return (right.latest_event?.timestamp ?? 0) - (left.latest_event?.timestamp ?? 0);
}

export function notifications(
  rooms: readonly RoomSummary[],
  filter: NotificationFilter
): RoomSummary[] {
  return rooms
    .filter((room) => room.state === 'joined' && !room.is_space && matchesFilter(room, filter))
    .sort(byRecency);
}

export function countNotifications(rooms: readonly RoomSummary[]): number {
  return notifications(rooms, 'all').reduce((total, room) => total + notificationCount(room), 0);
}

export function pendingInvites(rooms: readonly RoomSummary[]): RoomSummary[] {
  return rooms.filter((room) => room.state === 'invited').sort(byRecency);
}

export function countInvites(rooms: readonly RoomSummary[]): number {
  return rooms.reduce((total, room) => total + (room.state === 'invited' ? 1 : 0), 0);
}

/** The core reports an invitation as a latest event sent by the inviter. */
export function inviter(room: RoomSummary): string | null {
  return room.latest_event?.sender ?? null;
}

export function senderName(userId: string): string {
  return userId.startsWith('@') ? (userId.slice(1).split(':')[0] ?? userId) : userId;
}
