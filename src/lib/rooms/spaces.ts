import type { RoomSummary } from '#src/generated/RoomSummary';

export type UnreadCount = { unread: number; highlight: number };

export function spaceUnreadCounts(
  spaces: readonly RoomSummary[],
  rooms: readonly RoomSummary[],
  mutedRoomIds: ReadonlySet<string> = new Set()
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
      if (visited.has(room.room_id) || mutedRoomIds.has(room.room_id)) continue;
      visited.add(room.room_id);
      total.unread += room.unread;
      total.highlight += room.highlight;
    }
    return total;
  }

  const counts = new Map<string, UnreadCount>();
  for (const space of spaces) {
    const total = accumulate(space.room_id, new Set(), { unread: 0, highlight: 0 });
    if (total.unread > 0 || total.highlight > 0) counts.set(space.room_id, total);
  }
  return counts;
}

export function addUnread(left: UnreadCount, right: UnreadCount): UnreadCount {
  return { unread: left.unread + right.unread, highlight: left.highlight + right.highlight };
}
