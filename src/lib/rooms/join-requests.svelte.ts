import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type {
  JoinRequestRoomView,
  MemberView,
  RoomListItemView,
  RoomPermissionsView,
} from '#src/generated/protocol';

import type { RoomList } from './room-list.svelte.js';

export interface JoinRequest {
  room: RoomListItemView;
  member: MemberView;
  permissions: RoomPermissionsView;
}

export function joinRequestKey({ room, member }: JoinRequest): string {
  return `${room.room_id}/${member.user_id}/${member.member_ts ?? ''}`;
}

export function canApprove(request: JoinRequest): boolean {
  return request.permissions.can_invite;
}

export function canDeny({ member, permissions }: JoinRequest): boolean {
  return permissions.can_kick && member.power_level < permissions.own_power_level;
}

type JoinRequestsCore = Pick<CoreClient, 'rpc' | 'session' | 'subscribeEvents'>;

/** Pending knocks in every room where this user can answer them. */
export class JoinRequests {
  #groups = $state.raw<JoinRequestRoomView[]>([]);
  #answered = new SvelteSet<string>();
  #dismissed = new SvelteSet<string>();
  #run = 0;
  #core: JoinRequestsCore;
  #roomList: Pick<RoomList, 'rooms'>;
  loading = $state(true);
  failed = $state(false);
  actionFailed = $state(false);
  busy = $state(false);

  readonly pending: JoinRequest[] = $derived.by(() => {
    return this.#roomList.rooms
      .flatMap((room) => {
        const group = this.#groups.find((entry) => entry.room_id === room.room_id);
        return group
          ? group.members.map((member) => ({ room, member, permissions: group.permissions }))
          : [];
      })
      .filter((request) => !this.#answered.has(joinRequestKey(request)))
      .sort((left, right) => (right.member.member_ts ?? 0) - (left.member.member_ts ?? 0));
  });

  constructor(core: JoinRequestsCore, roomList: Pick<RoomList, 'rooms'>) {
    this.#core = core;
    this.#roomList = roomList;
    let shape = '';
    $effect(() => {
      // Room-list updates come with most messages; only rooms and join rules decide who can knock.
      const next = roomList.rooms.map((room) => `${room.room_id} ${room.join_rule}`).join('\n');
      if (next === shape) return;
      shape = next;
      void this.load();
    });
    $effect(() =>
      core.subscribeEvents((event) => {
        if (event.type !== 'members_changed') return;
        const { member } = event;
        if (
          member === null ||
          member.membership === 'knock' ||
          this.forRoom(event.room_id).some((request) => request.member.user_id === member.user_id)
        ) {
          void this.load();
        }
      })
    );
  }

  forRoom(roomId: string): JoinRequest[] {
    return this.pending.filter((request) => request.room.room_id === roomId);
  }

  /** Requests in the room that arrived since the user last dismissed its card. */
  unseen(roomId: string): JoinRequest[] {
    return this.forRoom(roomId).filter((request) => !this.#dismissed.has(joinRequestKey(request)));
  }

  dismiss(roomId: string): void {
    for (const request of this.forRoom(roomId)) this.#dismissed.add(joinRequestKey(request));
  }

  async load(): Promise<void> {
    const current = ++this.#run;
    this.loading = true;
    this.failed = false;
    try {
      const result = await this.#core.rpc.members.joinRequests({});
      if (current !== this.#run) return;
      this.#groups = result.rooms;
      this.failed = result.failed;
    } catch {
      if (current !== this.#run) return;
      this.#groups = [];
      this.failed = true;
    }
    this.loading = false;
  }

  async answer(request: JoinRequest, approve: boolean): Promise<void> {
    if (this.busy) return;
    const { room, member } = request;
    this.busy = true;
    this.actionFailed = false;
    try {
      if (approve) {
        await this.#core.rpc.rooms.invite({ room_id: room.room_id, user_id: member.user_id });
      } else {
        await this.#core.rpc.members.denyKnock({ room_id: room.room_id, user_id: member.user_id });
      }
      this.#answered.add(joinRequestKey(request));
    } catch (error) {
      console.warn('[sable] answering join request failed', error);
      this.actionFailed = true;
    } finally {
      this.busy = false;
    }
  }
}

const [useShared, provideJoinRequests, hasShared] = createContext<JoinRequests>();

export { provideJoinRequests };

export function useJoinRequests(core: JoinRequestsCore, roomList: Pick<RoomList, 'rooms'>) {
  return hasShared() ? useShared() : new JoinRequests(core, roomList);
}
