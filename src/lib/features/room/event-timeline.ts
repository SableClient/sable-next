import { resolve } from '$app/paths';

import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';

export function eventTimelinePath(roomId: string): string {
  return `${resolve('/(app)/rooms/[roomId]', { roomId: roomPathParamFromId(roomId) })}?timeline=events`;
}
