import { afterNavigate, goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';

import type { RoomSummary } from '#src/generated/protocol';

import { findRoomByPathId, roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
import { BREAKPOINTS } from '#lib/ui/breakpoints.js';

let enteredFrom: string | null = null;

export function trackRoomEntry(): void {
  afterNavigate((navigation) => {
    const wentBack = navigation.type === 'popstate' && navigation.delta < 0;
    enteredFrom = wentBack ? null : (navigation.from?.url.pathname ?? null);
  });
}

function roomListPath(): string {
  if (page.url.pathname.startsWith('/direct/')) return resolve('direct');
  if (page.url.pathname.startsWith('/space/') && page.params.spaceId) {
    const spaceId = roomPathParamFromId(page.params.spaceId);
    return window.matchMedia(BREAKPOINTS.appLayout).matches
      ? resolve('/(app)/space/[spaceId]/lobby', { spaceId })
      : resolve('/(app)/space/[spaceId]', { spaceId });
  }
  return resolve('/(app)/rooms');
}

export function leaveRoomView(): void {
  const target = roomListPath();
  if (enteredFrom === target) {
    enteredFrom = null;
    history.back();
    return;
  }
  void goto(target);
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
