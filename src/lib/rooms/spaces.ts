import type { RoomSummary } from '@/generated/RoomSummary';

export function unreadSpaceIds(
  spaces: readonly RoomSummary[],
  rooms: readonly RoomSummary[],
  mutedRoomIds: ReadonlySet<string> = new Set()
): Set<string> {
  const roomsById = new Map(
    rooms.filter((room) => room.state === 'joined').map((room) => [room.room_id, room])
  );

  function hasUnreadDescendant(spaceId: string, visited: Set<string>): boolean {
    if (visited.has(spaceId)) return false;
    visited.add(spaceId);
    const space = roomsById.get(spaceId);
    if (!space) return false;

    return space.space_children.some((child) => {
      const room = roomsById.get(child.room_id);
      if (!room) return false;
      if (room.is_space) return hasUnreadDescendant(room.room_id, visited);
      return !mutedRoomIds.has(room.room_id) && (room.unread > 0 || room.highlight > 0);
    });
  }

  return new Set(
    spaces
      .filter((space) => hasUnreadDescendant(space.room_id, new Set()))
      .map((space) => space.room_id)
  );
}
