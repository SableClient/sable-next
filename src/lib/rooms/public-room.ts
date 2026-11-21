import type { RoomListItemView } from '#src/generated/protocol';

export function isPublicRoom(room: RoomListItemView, rooms: readonly RoomListItemView[]): boolean {
  if (room.join_rule === 'public') return true;
  if (room.join_rule !== 'restricted' && room.join_rule !== 'knock_restricted') return false;

  return rooms.some(
    (space) =>
      space.join_rule === 'public' &&
      space.space_children.some((child) => child.room_id === room.room_id)
  );
}
