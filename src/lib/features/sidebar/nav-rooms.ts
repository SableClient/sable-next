import type { RoomSummary } from '#src/generated/RoomSummary';
import type { CoreCommands } from '#lib/core/commands.svelte.js';

export function claimedRoomIds(rooms: readonly RoomSummary[]): Set<string> {
  return new Set(
    rooms
      .filter(isActiveSpace)
      .flatMap((space) => space.space_children.map((child) => child.room_id))
  );
}

export function isActiveSpace(room: RoomSummary): boolean {
  return room.is_space && room.state === 'joined' && !room.is_tombstoned;
}

export function markRoomsRead(
  rooms: Iterable<RoomSummary | null | undefined>,
  commands: Pick<CoreCommands, 'markRead'>,
  privateReceipt = false
): void {
  for (const room of rooms) {
    const eventId = room?.latest_event?.event_id;
    if (!room || !eventId) continue;
    if (room.unread === 0 && room.highlight === 0 && !room.marked_unread) continue;

    void commands.markRead(room.room_id, eventId, privateReceipt).catch((error: unknown) => {
      console.warn('[sable nav] mark as read failed', error);
    });
  }
}

export function spaceDescendantRooms(
  rooms: readonly RoomSummary[],
  spaceId: string
): RoomSummary[] {
  const byId = new Map(rooms.map((room) => [room.room_id, room]));
  const seen = new Set<string>();
  const found: RoomSummary[] = [];

  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const space = byId.get(id);
    if (!space) return;
    for (const child of space.space_children) {
      const room = byId.get(child.room_id);
      if (!room || seen.has(room.room_id)) continue;
      if (room.is_space) {
        walk(room.room_id);
        continue;
      }
      seen.add(room.room_id);
      found.push(room);
    }
  };

  walk(spaceId);
  return found;
}
