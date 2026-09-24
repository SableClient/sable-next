import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';

import type { RoomSummary } from '#src/generated/protocol';

import { findRoomByPathId, roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';

export function leaveRoomView(): void {
  if (page.url.pathname.startsWith('/direct/')) {
    void goto(resolve('direct'));
    return;
  }
  if (page.url.pathname.startsWith('/space/') && page.params.spaceId) {
    void goto(
      resolve('/(app)/space/[spaceId]', { spaceId: roomPathParamFromId(page.params.spaceId) })
    );
    return;
  }
  void goto(resolve('/(app)/rooms'));
}

export function scopedSearchPath(
  operator: 'in' | 'space',
  room: RoomSummary | undefined,
  roomId: string
): string {
  const label = room?.canonical_alias ?? room?.name ?? roomId;
  const scope = label.includes(' ') ? `"${label}"` : label;
  return `${resolve('/(app)/search')}?q=${encodeURIComponent(`${operator}:${scope} `)}`;
}

export function contextSearchPath(
  rooms: readonly RoomSummary[],
  roomPathId: string | undefined,
  spacePathId: string | undefined
): string {
  const room = findRoomByPathId(rooms, roomPathId);
  if (room) return scopedSearchPath('in', room, room.room_id);
  const space = findRoomByPathId(rooms, spacePathId);
  if (space) return scopedSearchPath('space', space, space.room_id);
  return resolve('/(app)/search');
}

export function searchInRoom(room: RoomSummary | undefined, roomId: string): void {
  const target = scopedSearchPath('in', room, roomId);

  goto(target).catch(() => {
    window.location.assign(target);
  });
}
