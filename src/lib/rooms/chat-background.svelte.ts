import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { isHexColor } from '#lib/ui/hex-color.js';

const EVENT_TYPE = 'moe.sable.chat_background';

export interface ChatBackgroundChoice {
  image: string;
  color: string;
}

type Core = Pick<CoreClient, 'rpc' | 'session'>;

const rooms = new SvelteMap<string, ChatBackgroundChoice>();

function key(core: Core, roomId: string): string {
  return `${core.session?.account_id ?? ''}\n${roomId}`;
}

function read(content: unknown): ChatBackgroundChoice {
  const { image, color } = (content ?? {}) as Record<string, unknown>;
  return {
    image: typeof image === 'string' && image.startsWith('mxc://') ? image : '',
    color: typeof color === 'string' && isHexColor(color) ? color : '',
  };
}

/** The background chosen for this room alone, once `loadRoomBackground` has read it. */
export function roomBackground(core: Core, roomId: string): ChatBackgroundChoice | undefined {
  return rooms.get(key(core, roomId));
}

/** Never rejects: a room whose choice cannot be read counts as having none. */
export async function loadRoomBackground(core: Core, roomId: string): Promise<void> {
  const id = key(core, roomId);
  try {
    const content = await core.rpc.room_state.accountData({
      room_id: roomId,
      event_type: EVENT_TYPE,
    });
    rooms.set(id, read(content));
  } catch (error) {
    console.debug('[sable rooms] chat background unavailable', error);
    if (!rooms.has(id)) rooms.set(id, read(null));
  }
}

export async function saveRoomBackground(
  core: Core,
  roomId: string,
  choice: ChatBackgroundChoice
): Promise<void> {
  await core.rpc.room_state.setAccountData({
    room_id: roomId,
    event_type: EVENT_TYPE,
    content: choice,
  });
  rooms.set(key(core, roomId), choice);
}
