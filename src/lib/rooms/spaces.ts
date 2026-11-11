import type { NotificationModeView, RoomListItemView } from '#src/generated/protocol';

import type { UnreadCount } from './unread.js';

export function addUnread(left: UnreadCount, right: UnreadCount): UnreadCount {
  return {
    unread: left.unread + right.unread,
    highlight: left.highlight + right.highlight,
    marked: (left.marked ?? false) || (right.marked ?? false),
    notifying: (left.notifying ?? 0) + (right.notifying ?? 0),
  };
}

const MAX_SPACE_DEPTH = 4;

export function ancestorSpaceIds(rooms: readonly RoomListItemView[], roomId: string): string[] {
  return ancestorSpaceLevels(rooms, roomId).reverse().flat();
}

export function ancestorSpaceLevels(
  rooms: readonly RoomListItemView[],
  roomId: string
): string[][] {
  const levels: string[][] = [];
  const seen = new Set([roomId]);
  let frontier = [roomId];

  for (let depth = 0; depth < MAX_SPACE_DEPTH && frontier.length > 0; depth += 1) {
    const parents = rooms.filter(
      (space) =>
        space.room_kind === 'space' &&
        space.state === 'joined' &&
        !seen.has(space.room_id) &&
        space.space_children.some((child) => frontier.includes(child.room_id))
    );
    for (const parent of parents) seen.add(parent.room_id);
    frontier = parents.map((parent) => parent.room_id);
    if (frontier.length > 0) levels.push(frontier);
  }

  return levels;
}

export function descendantRoomIds(rooms: readonly RoomListItemView[], spaceId: string): string[] {
  const joined = new Map(
    rooms.filter((room) => room.state === 'joined').map((room) => [room.room_id, room])
  );
  const seen = new Set([spaceId]);
  const found: string[] = [];
  let frontier = [spaceId];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of joined.get(id)?.space_children ?? []) {
        if (seen.has(child.room_id) || !joined.has(child.room_id)) continue;
        seen.add(child.room_id);
        found.push(child.room_id);
        next.push(child.room_id);
      }
    }
    frontier = next;
  }

  return found;
}

export function inheritedNotificationModes(
  rooms: readonly RoomListItemView[],
  modes: ReadonlyMap<string, NotificationModeView>,
  exempt: ReadonlySet<string> = new Set()
): Map<string, NotificationModeView> {
  const joined = new Set(
    rooms.filter((room) => room.state === 'joined').map((room) => room.room_id)
  );
  const covered = new Set(
    [...modes.keys()]
      .filter((spaceId) => joined.has(spaceId))
      .flatMap((spaceId) => [spaceId, ...descendantRoomIds(rooms, spaceId)])
  );
  const inherited = new Map<string, NotificationModeView>();
  for (const roomId of covered) {
    if (exempt.has(roomId)) continue;
    const levels = [[roomId], ...ancestorSpaceLevels(rooms, roomId)];
    for (const level of levels) {
      const mode = level.map((id) => modes.get(id)).find((entry) => entry !== undefined);
      if (mode === undefined) continue;
      inherited.set(roomId, mode);
      break;
    }
  }
  return inherited;
}

/** The top-level space each room sits under, which tells apart rooms sharing a name. */
export function rootSpaceNames(rooms: readonly RoomListItemView[]): Map<string, string> {
  const parents = new Map<string, RoomListItemView>();
  for (const space of rooms) {
    if (space.room_kind !== 'space' || space.state !== 'joined' || space.is_tombstoned) continue;
    for (const child of space.space_children) {
      if (!parents.has(child.room_id)) parents.set(child.room_id, space);
    }
  }
  const names = new Map<string, string>();
  for (const roomId of parents.keys()) {
    const seen = new Set([roomId]);
    let root = parents.get(roomId);
    while (root !== undefined && !seen.has(root.room_id)) {
      seen.add(root.room_id);
      const parent = parents.get(root.room_id);
      if (parent === undefined || seen.has(parent.room_id)) break;
      root = parent;
    }
    if (root !== undefined) names.set(roomId, root.display_name);
  }
  return names;
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
  if (roomId === null) return new Set();
  return spacesContaining(spaces, rooms, (room) => room.room_id === roomId);
}

export function spacesContaining(
  spaces: readonly RoomListItemView[],
  rooms: readonly RoomListItemView[],
  matches: (room: RoomListItemView) => boolean
): Set<string> {
  const found = new Set<string>();
  const roomsById = new Map(rooms.map((room) => [room.room_id, room]));

  function contains(spaceId: string, visited: Set<string>): boolean {
    if (visited.has(spaceId)) return false;
    visited.add(spaceId);

    const space = roomsById.get(spaceId);
    if (!space) return false;

    return space.space_children.some((child) => {
      const room = roomsById.get(child.room_id);
      return (room !== undefined && matches(room)) || contains(child.room_id, visited);
    });
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
