import type { RoomListItemView } from '#src/generated/protocol';

import { resolve } from '$app/paths';

import { readText, writeText } from '#lib/platform/local-json.js';
import { roomSectionPath } from '#lib/rooms/permalink.js';
import { roomPathParam } from '#lib/rooms/room-list.svelte.js';
import { descendantRoomIds } from '#lib/rooms/spaces.js';

const KEY_PREFIX = 'sable-last-room:';
const SECTION_KEY_PREFIX = 'sable-last-room-section:';

export const HOME_SECTION = 'home';

export function lastRoomId(accountId: string): string | null {
  return readText(KEY_PREFIX + accountId);
}

export function lastRoomSection(accountId: string): string | null {
  return readText(SECTION_KEY_PREFIX + accountId) || null;
}

export function rememberLastRoom(accountId: string, roomId: string, section: string | null): void {
  writeText(KEY_PREFIX + accountId, roomId);
  writeText(SECTION_KEY_PREFIX + accountId, section ?? '');
}

export function restoredRoomPath(
  rooms: readonly RoomListItemView[],
  roomId: string,
  section: string | null,
  showHome: boolean
): string {
  const room = rooms.find((entry) => entry.room_id === roomId);
  if (room && !room.is_direct) {
    if (section === HOME_SECTION && showHome) {
      return resolve('/(app)/home/[roomId]', { roomId: roomPathParam(room, rooms) });
    }
    const space = rooms.find(
      (entry) =>
        entry.room_id === section &&
        entry.room_kind === 'space' &&
        entry.state === 'joined' &&
        !entry.is_tombstoned
    );
    if (space && descendantRoomIds(rooms, space.room_id).includes(roomId)) {
      return resolve('/(app)/space/[spaceId]/[roomId]', {
        spaceId: roomPathParam(space, rooms),
        roomId: roomPathParam(room, rooms),
      });
    }
  }
  return roomSectionPath(rooms, roomId);
}
