import type { RoomSummary } from '#src/generated/protocol';

import { type NotificationModeResolver, roomUnread, UNRESOLVED_MODE } from './unread.js';

export type UnreadCount = { unread: number; highlight: number; marked?: boolean };

export function spaceUnreadCounts(
  spaces: readonly RoomSummary[],
  rooms: readonly RoomSummary[],
  mode: NotificationModeResolver = UNRESOLVED_MODE
): Map<string, UnreadCount> {
  const roomsById = new Map(
    rooms.filter((room) => room.state === 'joined').map((room) => [room.room_id, room])
  );

  function accumulate(spaceId: string, visited: Set<string>, total: UnreadCount): UnreadCount {
    if (visited.has(spaceId)) return total;
    visited.add(spaceId);
    const space = roomsById.get(spaceId);
    if (!space) return total;

    for (const child of space.space_children) {
      const room = roomsById.get(child.room_id);
      if (!room) continue;
      if (room.is_space) {
        accumulate(room.room_id, visited, total);
        continue;
      }
      if (visited.has(room.room_id)) continue;
      visited.add(room.room_id);
      const counts = roomUnread(room, mode(room.room_id));
      if (counts.marked) total.marked = true;
      total.unread += counts.unread;
      total.highlight += counts.highlight;
    }
    return total;
  }

  const counts = new Map<string, UnreadCount>();
  for (const space of spaces) {
    const total = accumulate(space.room_id, new Set(), {
      unread: 0,
      highlight: 0,
      marked: false,
    });
    if (total.unread > 0 || total.highlight > 0 || total.marked) counts.set(space.room_id, total);
  }
  return counts;
}

export function addUnread(left: UnreadCount, right: UnreadCount): UnreadCount {
  return {
    unread: left.unread + right.unread,
    highlight: left.highlight + right.highlight,
    marked: (left.marked ?? false) || (right.marked ?? false),
  };
}

export type ChildRouting = { via: string[]; parentId: string | null };

export function childRouting(rooms: readonly RoomSummary[], roomId: string): ChildRouting {
  for (const space of rooms) {
    if (!space.is_space || space.state !== 'joined') continue;
    const edge = space.space_children.find((child) => child.room_id === roomId);
    if (edge) return { via: [...edge.via], parentId: space.room_id };
  }
  return { via: [], parentId: null };
}

export function spacesContainingRoom(
  spaces: readonly RoomSummary[],
  rooms: readonly RoomSummary[],
  roomId: string | null
): Set<string> {
  const found = new Set<string>();
  if (roomId === null) return found;

  const roomsById = new Map(rooms.map((room) => [room.room_id, room]));

  function contains(spaceId: string, visited: Set<string>): boolean {
    if (visited.has(spaceId)) return false;
    visited.add(spaceId);

    const space = roomsById.get(spaceId);
    if (!space) return false;

    return space.space_children.some(
      (child) => child.room_id === roomId || contains(child.room_id, visited)
    );
  }

  for (const space of spaces) {
    if (contains(space.room_id, new Set())) found.add(space.room_id);
  }
  return found;
}
