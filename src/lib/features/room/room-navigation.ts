import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';

import type { RoomSummary } from '#src/generated/protocol';

import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';

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

export function searchInRoom(room: RoomSummary | undefined, roomId: string): void {
  const label = room?.canonical_alias ?? room?.name ?? roomId;
  const scope = label.includes(' ') ? `"${label}"` : label;
  const target = `${resolve('/(app)/search')}?q=${encodeURIComponent(`in:${scope} `)}`;

  goto(target).catch(() => {
    window.location.assign(target);
  });
}
