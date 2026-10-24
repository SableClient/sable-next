import type { DirectoryRoomType, RoomListItemView } from '#src/generated/protocol';

export type AddExistingKind = DirectoryRoomType;

export function addableChildren(
  rooms: readonly RoomListItemView[],
  space: RoomListItemView,
  kind: AddExistingKind,
  query: string
): RoomListItemView[] {
  const listed = new Set(space.space_children.map((edge) => edge.room_id));
  const needle = query.trim().toLowerCase();

  return rooms
    .filter(
      (room) =>
        room.state === 'joined' &&
        !room.is_tombstoned &&
        !room.is_direct &&
        room.room_id !== space.room_id &&
        !listed.has(room.room_id) &&
        !room.space_children.some((edge) => edge.room_id === space.room_id)
    )
    .filter((room) => {
      if (kind === 'spaces') {
        return room.room_kind === 'space';
      }
      return room.room_kind !== 'space';
    })
    .filter(
      (room) =>
        needle === '' ||
        [room.name, room.canonical_alias, room.room_id].some((field) =>
          field?.toLowerCase().includes(needle)
        )
    )
    .sort((left, right) => (left.name ?? left.room_id).localeCompare(right.name ?? right.room_id));
}
