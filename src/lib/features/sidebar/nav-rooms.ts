import type { RoomSummary } from '#src/generated/RoomSummary';
import type { CoreCommands } from '#lib/core/commands.svelte.js';

export function claimedRoomIds(rooms: readonly RoomSummary[]): Set<string> {
  return new Set(
    rooms
      .filter((room) => room.is_space && room.state === 'joined')
      .flatMap((space) => space.space_children.map((child) => child.room_id))
  );
}

export function markRoomsRead(
  rooms: Iterable<RoomSummary | null | undefined>,
  commands: Pick<CoreCommands, 'markRead'>
): void {
  for (const room of rooms) {
    const eventId = room?.latest_event?.event_id;
    if (!room || !eventId || (room.unread === 0 && room.highlight === 0)) continue;

    void commands.markRead(room.room_id, eventId).catch((error: unknown) => {
      console.warn('[sable nav] mark as read failed', error);
    });
  }
}
