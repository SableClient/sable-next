import { createContext, untrack } from 'svelte';

import type {
  CoreEvent,
  NotificationModeView,
  RoomSummary,
  SubscriptionId,
} from '#src/generated/protocol';
import { applyDiffs } from '#src/transport';

import { bufferSubscription } from '#lib/core/buffered-subscription.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { quietTargets } from './quiet-rooms.svelte.js';
import { readRoomListSnapshot, writeRoomListSnapshot } from './room-list-snapshot.js';
import { quietRoomIds } from './spaces.js';
import {
  applyBadgeMode,
  badgeModeFor,
  quietUnread,
  roomNotifications,
  type RoomUnread,
  roomUnread,
} from './unread.js';

type RoomListDiffs = Extract<CoreEvent, { type: 'room_list_diff' }>['diffs'];

const SNAPSHOT_WRITE_DELAY_MS = 1_000;
const WARM_ROOM_LIMIT = 32;
const WARM_BATCH_MS = 100;

/** Only use an alias when it resolves locally to this room. */
const aliasOwners = new WeakMap<readonly RoomSummary[], Map<string, string>>();

function aliasOwner(rooms: readonly RoomSummary[], alias: string): string | undefined {
  let owners = aliasOwners.get(rooms);
  if (owners === undefined) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup index for one immutable rooms array
    owners = new Map();
    for (const room of rooms) {
      const owned = room.canonical_alias;
      if (!room.is_tombstoned && owned && !owners.has(owned)) owners.set(owned, room.room_id);
    }
    aliasOwners.set(rooms, owners);
  }
  return owners.get(alias);
}

export function roomPathId(room: RoomSummary, rooms: readonly RoomSummary[]): string {
  const alias = room.canonical_alias;
  if (!room.is_tombstoned && alias && aliasOwner(rooms, alias) === room.room_id) {
    return alias;
  }
  return room.room_id;
}

/** `resolve()` inserts route parameters verbatim, including `#`. */
export function roomPathParamFromId(roomId: string): string {
  return encodeURIComponent(roomId);
}

export function roomPathParam(room: RoomSummary, rooms: readonly RoomSummary[]): string {
  return roomPathParamFromId(roomPathId(room, rooms));
}

function directPeer(room: RoomSummary): string | null {
  return room.is_direct && room.direct_targets.length === 1 ? room.direct_targets[0] : null;
}

export function roomLabel(room: RoomSummary): string {
  const label = room.name ?? room.canonical_alias ?? room.room_id;
  const peer = directPeer(room);
  return peer === null ? label : profileOverrides.name(peer, label);
}

export function roomAvatarUrl(room: RoomSummary): string | null {
  const peer = directPeer(room);
  return peer === null ? room.avatar_url : profileOverrides.avatar(peer, room.avatar_url);
}

export function findRoomByPathId(
  rooms: readonly RoomSummary[],
  pathId: string | undefined
): RoomSummary | undefined {
  if (pathId === undefined) return undefined;
  return rooms.find(
    (room) => room.room_id === pathId || (!room.is_tombstoned && room.canonical_alias === pathId)
  );
}

const NOBODY_TYPING: readonly string[] = [];

export class RoomList {
  rooms = $state.raw<RoomSummary[]>([]);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  typingUsers = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());

  private subscription: SubscriptionId | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeTyping: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private snapshotAccountId: string | null = null;
  private snapshotWriteTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotDirty = false;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- resolved from setRooms, never rendered
  private readonly listedWaiters = new Set<{ roomId: string; resolve: () => void }>();
  private presentationActive = true;
  private live = $state(false);
  private warmed: string[] = [];
  private pendingWarm: string[] = [];
  private warmTimer: ReturnType<typeof setTimeout> | undefined;

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt wholesale, never mutated
  private readonly roomsById = $derived(new Map(this.rooms.map((room) => [room.room_id, room])));
  readonly quietRoomIds = $derived(quietRoomIds(this.rooms, quietTargets()));

  constructor(private readonly core: CoreClient) {}

  get settled(): boolean {
    return this.live;
  }

  byId(roomId: string | null | undefined): RoomSummary | undefined {
    return roomId === null || roomId === undefined ? undefined : this.roomsById.get(roomId);
  }

  whenListed(roomId: string, timeoutMs: number): Promise<void> {
    if (this.rooms.some((room) => room.room_id === roomId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { roomId, resolve: finish };
      const timer = setTimeout(finish, timeoutMs);
      this.listedWaiters.add(waiter);
      const waiters = this.listedWaiters;
      function finish(): void {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve();
      }
    });
  }

  labelFor(roomId: string): string {
    const room = this.byId(roomId);
    return room ? roomLabel(room) : roomId;
  }

  warm(roomId: string): void {
    if (this.warmed.includes(roomId)) return;
    this.warmed.push(roomId);
    if (this.warmed.length > WARM_ROOM_LIMIT) this.warmed.shift();
    this.pendingWarm.push(roomId);
    this.warmTimer ??= setTimeout(() => {
      this.warmTimer = undefined;
      const roomIds = this.pendingWarm;
      this.pendingWarm = [];
      this.core.commands.warmRooms(roomIds).catch(() => {});
    }, WARM_BATCH_MS);
  }

  setPresentationActive(active: boolean): void {
    this.presentationActive = active;
    if (active) this.flushSnapshot();
  }

  typingUserIds(roomId: string): readonly string[] {
    return this.typingUsers.get(roomId) ?? NOBODY_TYPING;
  }

  notificationOverride(roomId: string): NotificationModeView | null {
    return this.byId(roomId)?.notification.room ?? null;
  }

  notificationMode(roomId: string): NotificationModeView | null {
    const notification = this.byId(roomId)?.notification;
    return notification ? (notification.room ?? notification.default) : null;
  }

  readonly unreadFor: RoomUnread = roomUnread;

  readonly badgeUnreadFor: RoomUnread = (room) => {
    const counts = roomUnread(room);
    if (this.quietRoomIds.has(room.room_id)) return quietUnread(counts);
    return applyBadgeMode(
      counts,
      badgeModeFor(room, room.notification.room, {
        direct: preferences.badgeDefaultDirect,
        group: preferences.badgeDefaultGroup,
      })
    );
  };

  readonly notificationsFor: RoomUnread = roomNotifications;

  async start(): Promise<void> {
    if (this.subscription !== null) return;
    if (this.startPromise) return this.startPromise;

    untrack(() => {
      this.paintSnapshot();
    });
    const promise = this.startSubscription();
    this.startPromise = promise;

    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  stop(): void {
    this.generation += 1;
    this.startPromise = null;
    untrack(() => {
      this.flushSnapshot(true);
    });
    this.live = false;
    this.snapshotAccountId = null;
    clearTimeout(this.warmTimer);
    this.warmTimer = undefined;
    this.warmed = [];
    this.pendingWarm = [];
    this.rooms = [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    this.typingUsers = new Map();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeTyping?.();
    this.unsubscribeTyping = null;

    const subscription = this.subscription;
    this.subscription = null;
    if (subscription !== null) this.core.commands.unsubscribe(subscription).catch(() => {});
  }

  private async startSubscription(): Promise<void> {
    const generation = this.generation;
    const buffered = bufferSubscription<CoreEvent, RoomListDiffs[number], RoomSummary>(
      (listener) => this.core.subscribeEvents(listener),
      (event) => (event.type === 'room_list_diff' ? event : null),
      applyDiffs,
      (diffs) => {
        this.setRooms(applyDiffs(this.live ? this.rooms : [], diffs));
      }
    );

    let response;
    try {
      response = await this.core.commands.subscribeRoomList();
    } catch (error) {
      buffered.stop();
      throw error;
    }

    if (generation !== this.generation) {
      this.core.commands.unsubscribe(response.subscription).catch(() => {});
      buffered.stop();
      return;
    }

    this.subscription = response.subscription;
    const rooms = buffered.activate(response.subscription, response.rooms);
    if (rooms.length > 0 || !this.snapshotPainted()) this.setRooms(rooms);
    this.unsubscribeEvents = buffered.stop;
    this.unsubscribeTyping = this.core.subscribeEvents((event) => {
      if (event.type !== 'typing') return;

      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const rooms = new Map(this.typingUsers);
      if (event.user_ids.length > 0) rooms.set(event.room_id, event.user_ids);
      else rooms.delete(event.room_id);
      this.typingUsers = rooms;
    });
  }

  private paintSnapshot(): void {
    const accountId = this.core.session?.account_id ?? null;
    this.snapshotAccountId = accountId;
    if (accountId === null || this.rooms.length > 0) return;
    const snapshot = readRoomListSnapshot(accountId);
    if (snapshot && snapshot.length > 0) this.rooms = snapshot;
  }

  private snapshotPainted(): boolean {
    return !this.live && this.rooms.length > 0;
  }

  private scheduleSnapshotWrite(): void {
    this.snapshotDirty = true;
    if (
      !this.presentationActive ||
      this.snapshotAccountId === null ||
      this.snapshotWriteTimer !== undefined
    )
      return;
    this.snapshotWriteTimer = setTimeout(() => {
      this.flushSnapshot();
    }, SNAPSHOT_WRITE_DELAY_MS);
  }

  private flushSnapshot(force = false): void {
    if (this.snapshotWriteTimer !== undefined) clearTimeout(this.snapshotWriteTimer);
    this.snapshotWriteTimer = undefined;
    if (
      !this.snapshotDirty ||
      this.snapshotAccountId === null ||
      !this.live ||
      (!force && !this.presentationActive)
    )
      return;
    writeRoomListSnapshot(this.snapshotAccountId, this.rooms);
    this.snapshotDirty = false;
  }

  private setRooms(rooms: RoomSummary[]): void {
    this.live = true;
    this.rooms = rooms;
    for (const waiter of this.listedWaiters) {
      if (rooms.some((room) => room.room_id === waiter.roomId)) waiter.resolve();
    }
    this.scheduleSnapshotWrite();
  }
}

export const [useRoomList, provideRoomList] = createContext<RoomList>();
