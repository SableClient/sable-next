import type { RoomListItemView } from '#src/generated/protocol';

import type { RoomSpacesLookup } from '#lib/rooms/spaces.js';
import { findRoomByPathId } from '#lib/rooms/room-list.svelte.js';

export function personaSpaces(
  roomList: { readonly rooms: readonly RoomListItemView[]; readonly roomSpaces: RoomSpacesLookup },
  roomId: string,
  spacePathId: string | undefined
): { target: string | null; order: string[] } {
  const preferred = findRoomByPathId(roomList.rooms, spacePathId)?.room_id ?? null;
  const order = (roomList.roomSpaces(roomId)?.levels ?? []).flatMap((level) =>
    preferred !== null && level.includes(preferred)
      ? [preferred, ...level.filter((id) => id !== preferred)]
      : level
  );
  return {
    target: preferred !== null && order.includes(preferred) ? preferred : (order[0] ?? null),
    order,
  };
}
