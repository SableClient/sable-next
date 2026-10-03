import type { RoomSummary } from '#src/generated/protocol';

import { ancestorSpaceLevels } from '#lib/features/room/abbreviations.js';
import { findRoomByPathId } from '#lib/rooms/room-list.svelte.js';

export function personaSpaces(
  rooms: readonly RoomSummary[],
  roomId: string,
  spacePathId: string | undefined
): { target: string | null; order: string[] } {
  const preferred = findRoomByPathId(rooms, spacePathId)?.room_id ?? null;
  const order = ancestorSpaceLevels(rooms, roomId).flatMap((level) =>
    preferred !== null && level.includes(preferred)
      ? [preferred, ...level.filter((id) => id !== preferred)]
      : level
  );
  return {
    target: preferred !== null && order.includes(preferred) ? preferred : (order[0] ?? null),
    order,
  };
}
