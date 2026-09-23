import { SvelteSet } from 'svelte/reactivity';

import type { RoomSummary } from '#src/generated/protocol';

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';
import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

const declining = new SvelteSet<string>();

export function isDeclining(roomId: string): boolean {
  return declining.has(roomId);
}

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

  decline(room: RoomSummary): void {
    const roomId = room.room_id;
    if (this.answering.has(roomId) || declining.has(roomId)) return;
    declining.add(roomId);
    toasts.undoable(
      t('inbox.inviteDeclined', { room: room.name ?? room.canonical_alias ?? roomId }),
      {
        label: t('inbox.undo'),
        onUndo: () => {
          declining.delete(roomId);
        },
        onClose: () => {
          void this.answer(room, () => this.core.commands.leaveRoom(roomId)).then(() => {
            declining.delete(roomId);
          });
        },
      }
    );
  }

  private async answer(room: RoomSummary, run: () => Promise<void>): Promise<void> {
    if (this.answering.has(room.room_id)) return;
    this.answering.add(room.room_id);
    try {
      await run();
    } catch (error) {
      console.warn('[sable room] answering the invitation failed', error);
      toasts.error(t('errors.actionFailed'));
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
