import { SvelteSet } from 'svelte/reactivity';

import type { RoomSummary } from '#src/generated/RoomSummary';

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';

export class InviteActions {
  /** Rendered from, so the set has to be reactive. */
  private readonly answering = new SvelteSet<string>();

  constructor(private readonly core: CoreClient) {}

  isAnswering(roomId: string): boolean {
    return this.answering.has(roomId);
  }

  async accept(room: RoomSummary): Promise<void> {
    await this.answer(room, async () => {
      const roomId = await this.core.commands.joinRoom(room.room_id);
      await goto(roomHref(room, roomId));
    });
  }

  async decline(room: RoomSummary): Promise<void> {
    await this.answer(room, () => this.core.commands.leaveRoom(room.room_id));
  }

  private async answer(room: RoomSummary, run: () => Promise<void>): Promise<void> {
    if (this.answering.has(room.room_id)) return;
    this.answering.add(room.room_id);
    try {
      await run();
    } catch (error) {
      console.warn('[sable room] answering the invitation failed', error);
    } finally {
      this.answering.delete(room.room_id);
    }
  }
}

function roomHref(room: RoomSummary, roomId: string): string {
  const param = roomPathParamFromId(roomId);
  if (room.is_space) return resolve('/(app)/space/[spaceId]', { spaceId: param });
  if (room.is_direct) return resolve('/(app)/direct/[roomId]', { roomId: param });
  return resolve('/(app)/rooms/[roomId]', { roomId: param });
}
