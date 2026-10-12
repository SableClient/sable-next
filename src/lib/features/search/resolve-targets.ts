import type { RoomSummary, SearchRoom } from '#src/generated/protocol';

export type { SearchPerson, SearchRoom, TargetSuggestion } from '#src/generated/protocol';
export {
  resolveRoomTarget,
  resolveSpaceTarget,
  suggestPersonTarget,
  suggestRoomTarget,
} from '#lib/model/model.js';

export function searchRooms(rooms: readonly RoomSummary[]): SearchRoom[] {
  return rooms.map((room) => ({
    room_id: room.room_id,
    name: room.name,
    canonical_alias: room.canonical_alias,
    joined: room.state === 'joined',
    is_tombstoned: room.is_tombstoned,
    is_space: room.is_space,
    is_direct: room.is_direct,
    direct_targets: room.direct_targets,
    space_children: room.space_children,
  }));
}

export function parentSpaceOf(rooms: readonly RoomSummary[], roomId: string): string | undefined {
  return rooms.find(
    (room) =>
      room.is_space &&
      room.state === 'joined' &&
      room.space_children.some((child) => child.room_id === roomId)
  )?.room_id;
}
