import { goto } from '$app/navigation';
import type { Rpc } from '#src/generated/protocol';
import { joinRoom } from '#lib/core/api/rooms.js';
import { roomSectionPath } from '#lib/rooms/permalink.js';
import { findRoomByPathId, type RoomList } from '#lib/rooms/room-list.svelte.js';
import type { RoomSession } from './room-session.svelte.js';

export class TombstoneJoin {
  joining = $state(false);
  failed = $derived.by(() => {
    void this.roomId();
    void this.tombstoned();
    return false;
  });
  successorJoined = $derived.by(() => {
    const replacementId = this.session.tombstoneReplacementId;
    const successor = replacementId ? findRoomByPathId(this.roomList.rooms, replacementId) : null;
    return successor?.state === 'joined';
  });

  constructor(
    private readonly rpc: Pick<Rpc, 'rooms'>,
    private readonly roomList: Pick<RoomList, 'rooms' | 'whenListed'>,
    private readonly roomId: () => string,
    private readonly tombstoned: () => boolean,
    private readonly session: Pick<RoomSession, 'tombstoneReplacementId'>
  ) {}

  open(): void {
    const target = this.session.tombstoneReplacementId;
    if (!target) return;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    void goto(roomSectionPath(this.roomList.rooms, target));
  }

  async join(): Promise<void> {
    const target = this.session.tombstoneReplacementId;
    if (!target || this.joining) return;

    this.joining = true;
    this.failed = false;
    try {
      const via = await this.rpc.rooms.upgradeServers({ room_id: this.roomId() });
      const joinedId = await joinRoom(this.rpc, target, via);
      await this.roomList.whenListed(joinedId, 10_000);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
      void goto(roomSectionPath(this.roomList.rooms, joinedId));
    } catch (error) {
      console.warn('[sable room] joining the replacement room failed', error);
      this.failed = true;
    } finally {
      this.joining = false;
    }
  }
}
