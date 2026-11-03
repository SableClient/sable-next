import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { rawInvoke } from '#lib/platform/raw-invoke.js';
import type { RoomListItemView } from '#src/generated/protocol';

const AVATAR_SIZE = 256;

export function donateSentMessage(core: CoreClient, room: RoomListItemView | undefined): void {
  const userId = core.session?.user_id;
  if (!isTauri() || osType() !== 'ios' || !userId || !room) return;
  void donate(core, userId, room).catch((error: unknown) => {
    console.debug('[sable share-target] donating the conversation failed', error);
  });
}

async function donate(core: CoreClient, userId: string, room: RoomListItemView): Promise<void> {
  const avatar = room.avatar_url
    ? await core.media.fetchMedia(room.avatar_url, AVATAR_SIZE, AVATAR_SIZE).catch(() => null)
    : null;
  await rawInvoke('donate_sent_message', avatar ?? new Uint8Array(), {
    'user-id': userId,
    'room-id': room.room_id,
    name: room.display_name,
  });
}
