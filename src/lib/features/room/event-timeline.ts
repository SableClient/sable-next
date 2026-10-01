import { resolve } from '$app/paths';

import type { RoomSummary } from '#src/generated/protocol';

import { roomPathParam, roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';

export function eventTimelinePath(roomId: string): string {
  return `${resolve('/(app)/rooms/[roomId]', { roomId: roomPathParamFromId(roomId) })}?timeline=events`;
}

export function spaceTimelinePath(space: RoomSummary): string {
  const spaceId = roomPathParam(space);
  return `${resolve('/(app)/space/[spaceId]/[roomId]', { spaceId, roomId: spaceId })}?timeline=events`;
}
