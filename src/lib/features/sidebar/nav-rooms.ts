import type { RoomListItemView, Rpc } from '#src/generated/protocol';

export function claimedRoomIds(rooms: readonly RoomListItemView[]): Set<string> {
  return new Set(
    rooms
      .filter(isActiveSpace)
      .flatMap((space) =>
        space.space_children.filter((child) => child.via.length > 0).map((child) => child.room_id)
      )
  );
}

export function isActiveSpace(room: RoomListItemView): boolean {
  return room.room_kind === 'space' && room.state === 'joined' && !room.is_tombstoned;
}

export function markRoomsRead(
  rooms: Iterable<RoomListItemView | null | undefined>,
  timeline: Pick<Rpc['timeline'], 'markRead'>
): void {
  for (const room of rooms) {
    if (!room) continue;
    if (room.unread === 0 && room.highlight === 0 && !room.marked_unread) continue;
    if (!room.latest_event) continue;

    void timeline
      .markRead({
        room_id: room.room_id,
        event_id: null,
        thread_root: null,
        subscription: null,
        fully_read: true,
      })
      .catch((error: unknown) => {
        console.warn('[sable nav] mark as read failed', error);
      });
  }
}

export function markRoomUnread(
  roomId: string,
  timeline: Pick<Rpc['timeline'], 'markUnread'>
): void {
  void timeline.markUnread({ room_id: roomId, read_marker: null }).catch((error: unknown) => {
    console.warn('[sable nav] mark as unread failed', error);
  });
}
