import type { RoomListItemView } from '#src/generated/protocol';

import type { RoomUnread, UnreadCount } from './unread.js';

export function spaceUnreadTotals(
  spaces: readonly RoomListItemView[],
  rooms: readonly RoomListItemView[],
  unreadFor: RoomUnread
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
      if (room.room_kind === 'space') {
        accumulate(room.room_id, visited, total);
        continue;
      }
      if (visited.has(room.room_id)) continue;
      visited.add(room.room_id);
      const counts = unreadFor(room);
      if (counts.marked) total.marked = true;
      total.unread += counts.unread;
      total.highlight += counts.highlight;
      total.notifying = (total.notifying ?? 0) + (counts.notifying ?? 0);
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
    notifying: (left.notifying ?? 0) + (right.notifying ?? 0),
  };
}

export function quietRoomIds(
  rooms: readonly RoomListItemView[],
  targets: Iterable<string>
): Set<string> {
  const roomsById = new Map(rooms.map((room) => [room.room_id, room]));
  const quiet = new Set<string>();

  function walk(roomId: string): void {
    if (quiet.has(roomId)) return;
    quiet.add(roomId);
    for (const child of roomsById.get(roomId)?.space_children ?? []) walk(child.room_id);
  }

  for (const roomId of targets) walk(roomId);
  return quiet;
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

/** Private links show up as children of their spaces, after the space's own. */
export function withDmSpaceChildren(
  rooms: readonly RoomListItemView[],
  links: ReadonlyMap<string, readonly string[]>
): RoomListItemView[] {
  if (links.size === 0) return [...rooms];
  const present = new Set(rooms.map((room) => room.room_id));
  const childrenOf = new Map<string, string[]>();
  for (const [roomId, spaceIds] of links) {
    if (!present.has(roomId)) continue;
    for (const spaceId of spaceIds)
      childrenOf.set(spaceId, [...(childrenOf.get(spaceId) ?? []), roomId]);
  }
  return rooms.map((room) => {
    const added = childrenOf.get(room.room_id);
    if (!added || room.room_kind !== 'space') return room;
    const known = new Set(room.space_children.map((child) => child.room_id));
    const extra = added
      .filter((roomId) => !known.has(roomId))
      .map((roomId) => ({
        room_id: roomId,
        via: [roomId.slice(roomId.indexOf(':') + 1)],
        order: null,
        origin_server_ts: 0,
        suggested: false,
      }));
    return extra.length === 0
      ? room
      : { ...room, space_children: [...room.space_children, ...extra] };
  });
}
