import type { RoomListItemView } from '#src/generated/protocol';

import type { UnreadCount } from './unread.js';

export function addUnread(left: UnreadCount, right: UnreadCount): UnreadCount {
  return {
    unread: left.unread + right.unread,
    highlight: left.highlight + right.highlight,
    marked: left.marked || right.marked,
    notifying: left.notifying + right.notifying,
  };
}

export type ChildRouting = { via: string[]; parentId: string | null };

export function childRouting(rooms: readonly RoomListItemView[], roomId: string): ChildRouting {
  for (const space of rooms) {
    if (space.room_kind !== 'space' || space.state !== 'joined') continue;
    const edge = space.space_children.find((child) => child.room_id === roomId);
    if (edge) return { via: [...edge.via], parentId: space.room_id };
  }
  return { via: [], parentId: null };
}

export function spacesContainingRoom(
  spaces: readonly RoomListItemView[],
  rooms: readonly RoomListItemView[],
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

export function joinedSpaceRooms(
  space: RoomListItemView | null | undefined,
  byId: (roomId: string) => RoomListItemView | undefined
): string[] {
  const found: string[] = [];
  if (!space) return found;
  const seen: string[] = [space.room_id];
  const walk = (parent: RoomListItemView) => {
    for (const edge of parent.space_children) {
      if (seen.includes(edge.room_id)) continue;
      seen.push(edge.room_id);
      const child = byId(edge.room_id);
      if (child?.state !== 'joined') continue;
      if (child.room_kind === 'space') walk(child);
      else found.push(child.room_id);
    }
  };
  walk(space);
  return found;
}
