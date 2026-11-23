import type {
  NotificationModeView,
  RoomSpacesView,
  RoomListItemView,
  SpaceChildEdge,
} from '#src/generated/protocol';

import type { UnreadCount } from './unread.js';

/** An edge without a route is a delisting, unless it is private; mirrors `SpaceChildEdge::lists_room`. */
export function listsRoom(edge: SpaceChildEdge): boolean {
  return edge.private || edge.via.length > 0;
}

export function addUnread(left: UnreadCount, right: UnreadCount): UnreadCount {
  return {
    unread: left.unread + right.unread,
    highlight: left.highlight + right.highlight,
    marked: (left.marked ?? false) || (right.marked ?? false),
    notifying: (left.notifying ?? 0) + (right.notifying ?? 0),
  };
}

export type RoomSpacesLookup = (roomId: string) => RoomSpacesView | undefined;

export function ancestorSpaceIds(spaces: RoomSpacesView | undefined): string[] {
  return spaces?.levels.slice().reverse().flat() ?? [];
}

export function inheritedNotificationModes(
  roomSpaces: RoomSpacesLookup,
  modes: ReadonlyMap<string, NotificationModeView>,
  exempt: ReadonlySet<string> = new Set()
): Map<string, NotificationModeView> {
  const covered = new Set(
    [...modes.keys()].flatMap((spaceId) => {
      const space = roomSpaces(spaceId);
      return space?.joined ? [spaceId, ...space.descendants] : [];
    })
  );
  const inherited = new Map<string, NotificationModeView>();
  for (const roomId of covered) {
    if (exempt.has(roomId)) continue;
    const levels = [[roomId], ...(roomSpaces(roomId)?.levels ?? [])];
    for (const level of levels) {
      const mode = level.map((id) => modes.get(id)).find((entry) => entry !== undefined);
      if (mode === undefined) continue;
      inherited.set(roomId, mode);
      break;
    }
  }
  return inherited;
}

export function spacesContaining(
  spaces: readonly RoomListItemView[],
  rooms: readonly RoomListItemView[],
  roomSpaces: RoomSpacesLookup,
  matches: (room: RoomListItemView) => boolean
): Set<string> {
  const holders = new Set(
    rooms.filter(matches).flatMap((room) => roomSpaces(room.room_id)?.containing ?? [])
  );
  return new Set(spaces.map((space) => space.room_id).filter((id) => holders.has(id)));
}
