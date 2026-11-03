import type { RoomListItemView } from '#src/generated/protocol';
import { type RoomUnread, roomUnread } from '#lib/rooms/unread.js';

import { fuzzyFilter } from './fuzzy.js';

const MAX_RESULTS = 20;

export type JumpKind = 'room' | 'space' | 'direct';

const PREFIXES = new Map<string, JumpKind>([
  ['#', 'room'],
  ['*', 'space'],
  ['@', 'direct'],
]);

export function jumpKind(room: RoomListItemView): JumpKind {
  if (room.room_kind === 'space') return 'space';
  if (room.is_direct) return 'direct';
  return 'room';
}

export function parseJumpQuery(query: string): { kind: JumpKind | null; text: string } {
  const trimmed = query.trimStart();
  const kind = PREFIXES.get(trimmed.slice(0, 1)) ?? null;

  return { kind, text: (kind === null ? trimmed : trimmed.slice(1)).trim() };
}

export function filterRoomsByQuery(
  rooms: readonly RoomListItemView[],
  query: string,
  limit: number = MAX_RESULTS
): RoomListItemView[] {
  const { kind, text } = parseJumpQuery(query);
  const joined = rooms.filter((room) => room.state === 'joined');
  const candidates = kind === null ? joined : joined.filter((room) => jumpKind(room) === kind);

  if (text === '') {
    const recents =
      kind === null ? candidates.filter((room) => room.room_kind !== 'space') : candidates;
    return recents.slice(0, limit);
  }

  return fuzzyFilter(candidates, text, (room) => room.display_name, limit);
}

export function parentSpaceNames(rooms: readonly RoomListItemView[]): Map<string, string> {
  const parents = new Map<string, string>();

  for (const space of rooms) {
    if (space.room_kind !== 'space') continue;

    for (const child of space.space_children) {
      if (!parents.has(child.room_id)) parents.set(child.room_id, space.display_name);
    }
  }

  return parents;
}

export function unreadRoomsByPriority(
  rooms: readonly RoomListItemView[],
  excludeRoomId: string | null,
  unreadFor: RoomUnread = roomUnread
): RoomListItemView[] {
  return rooms
    .map((room) => ({ room, counts: unreadFor(room) }))
    .filter(({ room, counts }) => counts.unread > 0 && room.room_id !== excludeRoomId)
    .sort((a, b) => b.counts.highlight - a.counts.highlight || b.counts.unread - a.counts.unread)
    .map(({ room }) => room);
}
