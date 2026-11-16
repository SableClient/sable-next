import type { RoomListItemView, RoomSpacesView } from '#src/generated/protocol';

import { roomSpaces } from '#lib/model/model.js';

export function roomSpacesLookup(
  rooms: readonly RoomListItemView[]
): (roomId: string) => RoomSpacesView | undefined {
  const byId = new Map(roomSpaces(rooms).map((entry) => [entry.room_id, entry]));
  return (roomId) => byId.get(roomId);
}
