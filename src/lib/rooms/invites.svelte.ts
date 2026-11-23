import { SvelteSet } from 'svelte/reactivity';

import type { RoomListItemView } from '#src/generated/protocol';

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { joinRoom } from '#lib/core/api/rooms.js';
import { t } from '#lib/i18n.js';
import { roomSectionPath } from '#lib/rooms/permalink.js';
import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

const declining = new SvelteSet<string>();

export function isDeclining(roomId: string): boolean {
  return declining.has(roomId);
}

export class InviteActions {
  /** Rendered from, so the set has to be reactive. */
  private readonly answering = new SvelteSet<string>();

  constructor(
    private readonly core: CoreClient,
    private readonly roomList: { readonly rooms: readonly RoomListItemView[] }
  ) {}

  isAnswering(roomId: string): boolean {
    return this.answering.has(roomId);
  }

  async accept(room: RoomListItemView): Promise<void> {
    await this.answer(room, async () => {
      const roomId = await joinRoom(this.core.rpc, room.room_id);
      const path =
        room.room_kind === 'space'
          ? resolve('/(app)/space/[spaceId]', { spaceId: roomPathParamFromId(roomId) })
          : roomSectionPath(this.roomList.rooms, roomId);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- both routes are resolved above
      await goto(path);
    });
  }

  async acceptAll(rooms: readonly RoomListItemView[]): Promise<void> {
    const pending = rooms.filter((room) => !this.answering.has(room.room_id));
    for (const room of pending) this.answering.add(room.room_id);
    let failed = 0;
    for (const room of pending) {
      try {
        await joinRoom(this.core.rpc, room.room_id);
      } catch (error) {
        failed += 1;
        console.warn('[sable room] accepting the invitation failed', error);
      } finally {
        this.answering.delete(room.room_id);
      }
    }
    if (failed > 0) toasts.error(t('inbox.acceptAllFailed', { count: failed }));
  }

  decline(room: RoomListItemView): void {
    const roomId = room.room_id;
    if (this.answering.has(roomId) || declining.has(roomId)) return;
    declining.add(roomId);
    toasts.undoable(
      t('inbox.inviteDeclined', { room: room.name ?? room.canonical_alias ?? roomId }),
      {
        label: t('common.undo'),
        onUndo: () => {
          declining.delete(roomId);
        },
        onClose: () => {
          void this.answer(room, () => this.core.rpc.rooms.leave({ room_id: roomId })).then(() => {
            declining.delete(roomId);
          });
        },
      }
    );
  }

  declineAll(rooms: readonly RoomListItemView[]): void {
    const pending = rooms.filter(
      (room) => !this.answering.has(room.room_id) && !declining.has(room.room_id)
    );
    if (pending.length === 0) return;
    for (const room of pending) declining.add(room.room_id);
    toasts.undoable(t('inbox.invitesDeclined', { count: pending.length }), {
      label: t('common.undo'),
      onUndo: () => {
        for (const room of pending) declining.delete(room.room_id);
      },
      onClose: () => {
        void this.leaveAll(pending);
      },
    });
  }

  async blockAndDecline(
    rooms: readonly RoomListItemView[],
    senders: readonly string[]
  ): Promise<void> {
    let failed = 0;
    for (const sender of senders) {
      try {
        await this.core.rpc.account.ignoreUser({ user_id: sender });
      } catch (error) {
        failed += 1;
        console.warn('[sable room] blocking an inviter failed', error);
      }
    }
    if (failed > 0) toasts.error(t('inbox.blockSendersFailed', { count: failed }));
    const pending = rooms.filter(
      (room) => !this.answering.has(room.room_id) && !declining.has(room.room_id)
    );
    for (const room of pending) declining.add(room.room_id);
    await this.leaveAll(pending);
  }

  private async leaveAll(rooms: readonly RoomListItemView[]): Promise<void> {
    for (const room of rooms) this.answering.add(room.room_id);
    let failed = 0;
    for (const room of rooms) {
      try {
        await this.core.rpc.rooms.leave({ room_id: room.room_id });
      } catch (error) {
        failed += 1;
        console.warn('[sable room] declining the invitation failed', error);
      } finally {
        this.answering.delete(room.room_id);
        declining.delete(room.room_id);
      }
    }
    if (failed > 0) toasts.error(t('inbox.declineAllFailed', { count: failed }));
  }

  private async answer(room: RoomListItemView, run: () => Promise<unknown>): Promise<void> {
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
