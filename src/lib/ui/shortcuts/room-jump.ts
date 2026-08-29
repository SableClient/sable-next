import type { RoomSummary } from '#src/generated/RoomSummary';

import { fuzzyFilter } from './fuzzy.js';

const MAX_RESULTS = 20;

export function roomDisplayName(room: RoomSummary): string {
  return room.name ?? room.canonical_alias ?? room.room_id;
}

export function filterRoomsByQuery(
  rooms: readonly RoomSummary[],
  query: string,
  limit: number = MAX_RESULTS
): RoomSummary[] {
  const joined = rooms.filter((room) => room.state === 'joined');
  return fuzzyFilter(joined, query, roomDisplayName, limit);
}

export function unreadRoomsByPriority(
  rooms: readonly RoomSummary[],
  excludeRoomId: string | null
): RoomSummary[] {
  return rooms
    .filter((room) => room.unread > 0 && room.room_id !== excludeRoomId)
    .toSorted((a, b) => b.highlight - a.highlight || b.unread - a.unread);
}
