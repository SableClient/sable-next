import type { RoomSummary } from '#src/generated/protocol';

import { fuzzyFilter } from './fuzzy.js';

const MAX_RESULTS = 20;

export type JumpKind = 'room' | 'space' | 'direct';

const PREFIXES = new Map<string, JumpKind>([
  ['#', 'room'],
  ['*', 'space'],
  ['@', 'direct'],
]);

export function roomDisplayName(room: RoomSummary): string {
  return room.name ?? room.canonical_alias ?? room.room_id;
}

export function jumpKind(room: RoomSummary): JumpKind {
  if (room.is_space) return 'space';
  if (room.is_direct) return 'direct';
  return 'room';
}

export function parseJumpQuery(query: string): { kind: JumpKind | null; text: string } {
  const trimmed = query.trimStart();
  const kind = PREFIXES.get(trimmed.slice(0, 1)) ?? null;

  return { kind, text: (kind === null ? trimmed : trimmed.slice(1)).trim() };
}

function byActivity(rooms: readonly RoomSummary[]): RoomSummary[] {
  return rooms.toSorted(
    (a, b) => (b.latest_event?.timestamp ?? 0) - (a.latest_event?.timestamp ?? 0)
  );
}

export function filterRoomsByQuery(
  rooms: readonly RoomSummary[],
  query: string,
  limit: number = MAX_RESULTS
): RoomSummary[] {
  const { kind, text } = parseJumpQuery(query);
  const joined = rooms.filter((room) => room.state === 'joined');
  const candidates = kind === null ? joined : joined.filter((room) => jumpKind(room) === kind);

  if (text === '') {
    const recents = kind === null ? candidates.filter((room) => !room.is_space) : candidates;
    return byActivity(recents).slice(0, limit);
  }

  return fuzzyFilter(candidates, text, roomDisplayName, limit);
}

export function parentSpaceNames(rooms: readonly RoomSummary[]): Map<string, string> {
  const parents = new Map<string, string>();

  for (const space of rooms) {
    if (!space.is_space) continue;

    for (const child of space.space_children) {
      if (!parents.has(child.room_id)) parents.set(child.room_id, roomDisplayName(space));
    }
  }

  return parents;
}

export function unreadRoomsByPriority(
  rooms: readonly RoomSummary[],
  excludeRoomId: string | null
): RoomSummary[] {
  return rooms
    .filter((room) => room.unread > 0 && room.room_id !== excludeRoomId)
    .toSorted((a, b) => b.highlight - a.highlight || b.unread - a.unread);
}
