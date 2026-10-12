import type { CoreClient } from '#lib/core/client.svelte.js';

export const ROOM_BANNER_EVENT = 'page.codeberg.everypizza.room.banner';

export const bannerChanges = $state({ version: 0 });

export function bannerChanged(): void {
  bannerChanges.version += 1;
}

export async function readRoomBanner(core: CoreClient, roomId: string): Promise<string | null> {
  try {
    return await core.commands.roomBanner(roomId);
  } catch (error) {
    console.debug('[sable room] banner unavailable', error);
    return null;
  }
}

export async function setRoomBanner(
  core: CoreClient,
  roomId: string,
  url: string | null
): Promise<void> {
  await core.commands.setRoomBanner(roomId, url);
  bannerChanged();
}
