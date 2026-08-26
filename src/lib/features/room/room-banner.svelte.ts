import type { CoreClient } from '#lib/core/client.svelte.js';

export const ROOM_BANNER_EVENT = 'page.codeberg.everypizza.room.banner';

export const bannerChanges = $state({ version: 0 });

export function bannerChanged(): void {
  bannerChanges.version += 1;
}

export function bannerUrl(content: unknown): string | null {
  if (typeof content !== 'object' || content === null) return null;

  const { url } = content as { url?: unknown };
  return typeof url === 'string' && url.startsWith('mxc://') ? url : null;
}

export async function readRoomBanner(core: CoreClient, roomId: string): Promise<string | null> {
  try {
    return bannerUrl(await core.commands.roomStateEvent(roomId, ROOM_BANNER_EVENT));
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
  await core.commands.sendStateEvent(roomId, ROOM_BANNER_EVENT, '', { url: url ?? '' });
  bannerChanged();
}
