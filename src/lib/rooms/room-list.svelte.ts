import { createContext, untrack } from 'svelte';

import type {
  CoreEvent,
  NotificationModeView,
  RoomBadgeView,
  RoomListItemView,
  RoomListOptionsView,
  RoomSectionView,
  RoomSectionsUpdate,
  RoomUnreadView,
  SubscriptionId,
} from '#src/generated/protocol';
import { applyDiffs } from '#src/transport';

import { bufferSubscription } from '#lib/core/buffered-subscription.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { ungroupedFavourites } from './favourite-grouping.svelte.js';
import { quietRooms } from './quiet-rooms.svelte.js';
import {
  readRoomListSnapshot,
  type RoomListSnapshot,
  writeRoomListSnapshot,
} from './room-list-snapshot.js';
import { NO_UNREAD, roomNotifications, type RoomUnread, roomUnread } from './unread.js';

type RoomListBatch = Extract<CoreEvent, { type: 'room_list_diff' }>;

export function roomListOptions(): RoomListOptionsView {
  return {
    room_sort: preferences.roomSort,
    direct_sort: preferences.directSort,
    ungrouped_favourites: ungroupedFavourites(),
    subspace_depth: Number(preferences.subspaceHierarchyLimit),
    badge_default_direct: preferences.badgeDefaultDirect,
    badge_default_group: preferences.badgeDefaultGroup,
    quiet_rooms: quietRooms(),
  };
}

function sectionsOf(sections: readonly RoomSectionView[]): ReadonlyMap<string, RoomSectionView> {
  return new Map(sections.map((section) => [section.key, section]));
}

function badgesOf(badges: readonly RoomBadgeView[]): ReadonlyMap<string, RoomUnreadView> {
  return new Map(badges.map((badge) => [badge.room_id, badge.counts]));
}

function quietOf(roomIds: readonly string[]): ReadonlySet<string> {
  return new Set(roomIds);
}

function applySections(
  sections: ReadonlyMap<string, RoomSectionView>,
  update: RoomSectionsUpdate
): ReadonlyMap<string, RoomSectionView> {
  if (update.sections.length === 0 && update.removed.length === 0) return sections;
  const removed = new Set(update.removed);
  return sectionsOf([
    ...[...sections.values()].filter((section) => !removed.has(section.key)),
    ...update.sections,
  ]);
}

const SNAPSHOT_WRITE_DELAY_MS = 1_000;
const WARM_ROOM_LIMIT = 32;
const WARM_BATCH_MS = 100;

/** Only use an alias when it resolves locally to this room. */
const aliasOwners = new WeakMap<readonly RoomListItemView[], Map<string, string>>();

function aliasOwner(rooms: readonly RoomListItemView[], alias: string): string | undefined {
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

export function roomPathId(room: RoomListItemView, rooms: readonly RoomListItemView[]): string {
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

export function roomPathParam(room: RoomListItemView, rooms: readonly RoomListItemView[]): string {
  return roomPathParamFromId(roomPathId(room, rooms));
}

export function hasDirectRoom(rooms: readonly RoomListItemView[], userId: string): boolean {
  return rooms.some(
    (room) => room.is_direct && !room.is_tombstoned && room.direct_targets.includes(userId)
  );
}

export function findRoomByPathId(
  rooms: readonly RoomListItemView[],
  pathId: string | undefined
): RoomListItemView | undefined {
  if (pathId === undefined) return undefined;
  return rooms.find(
    (room) => room.room_id === pathId || (!room.is_tombstoned && room.canonical_alias === pathId)
  );
}

const NOBODY_TYPING: readonly string[] = [];

export class RoomList {
  #source = $state.raw<RoomListItemView[]>([]);
  #sections = $state.raw(sectionsOf([]));
  #badges = $state.raw(badgesOf([]));
  /** In the core's recency order, so a filtered view needs no recency sort of its own. */
  rooms = $derived(this.#source);
  quietRoomIds = $state.raw(quietOf([]));
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  typingUsers = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());

  private subscription: SubscriptionId | null = null;
  private sentOptions: string | null = null;
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

  constructor(private readonly core: CoreClient) {}

  get settled(): boolean {
    return this.live;
  }

  byId(roomId: string | null | undefined): RoomListItemView | undefined {
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
    return room ? room.display_name : roomId;
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
      this.core.rpc.timeline.warmRooms({ room_ids: roomIds }).catch((error: unknown) => {
        console.debug('[sable rooms] rooms not warmed', error);
      });
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

  readonly badgeUnreadFor: RoomUnread = (room) => this.#badges.get(room.room_id) ?? NO_UNREAD;

  section(key: string): RoomSectionView | undefined {
    return this.#sections.get(key);
  }

  setOptions(options: RoomListOptionsView): void {
    const sent = JSON.stringify(options);
    if (this.subscription === null || sent === this.sentOptions) return;
    this.sentOptions = sent;
    this.core.rpc.timeline.setRoomListOptions({ options }).catch((error: unknown) => {
      console.debug('[sable rooms] room list options not sent', error);
    });
  }

  readonly notificationsFor: RoomUnread = roomNotifications;

  async start(): Promise<void> {
    if (this.subscription !== null) return;
    if (this.startPromise) return this.startPromise;

    // Options are sent by `setOptions`, so the effect that starts the list must not resubscribe on them.
    const promise = untrack(() => {
      this.paintSnapshot();
      return this.startSubscription();
    });
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
    this.#source = [];
    this.#sections = sectionsOf([]);
    this.#badges = badgesOf([]);
    this.quietRoomIds = quietOf([]);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    this.typingUsers = new Map();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeTyping?.();
    this.unsubscribeTyping = null;

    const subscription = this.subscription;
    this.subscription = null;
    if (subscription !== null) {
      this.core.rpc.timeline.unsubscribe({ subscription }).catch((error: unknown) => {
        console.debug('[sable rooms] room list not unsubscribed', error);
      });
    }
  }

  private async startSubscription(): Promise<void> {
    const generation = this.generation;
    const buffered = bufferSubscription<CoreEvent, RoomListBatch, RoomListBatch>(
      (listener) => this.core.subscribeEvents(listener),
      (event) =>
        event.type === 'room_list_diff'
          ? { subscription: event.subscription, diffs: [event] }
          : null,
      (held, batches) => [...held, ...batches],
      (batches) => {
        this.applyBatches(batches, []);
      }
    );

    let response;
    try {
      const options = roomListOptions();
      this.sentOptions = JSON.stringify(options);
      response = await this.core.rpc.timeline.subscribeRoomList({ options });
    } catch (error) {
      buffered.stop();
      throw error;
    }

    if (generation !== this.generation) {
      this.core.rpc.timeline
        .unsubscribe({ subscription: response.subscription })
        .catch((error: unknown) => {
          console.debug('[sable rooms] stale room list not unsubscribed', error);
        });
      buffered.stop();
      return;
    }

    this.subscription = response.subscription;
    this.setOptions(roomListOptions());
    const batches = buffered.activate(response.subscription, []);
    const listed = response.rooms.length > 0 || batches.some((batch) => batch.diffs.length > 0);
    if (listed || !this.snapshotPainted()) this.applyBatches(batches, response.rooms);
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
    if (!snapshot || snapshot.rooms.length === 0) return;
    this.#source = snapshot.rooms;
    this.#sections = sectionsOf(snapshot.sections);
    this.#badges = badgesOf(snapshot.badges);
    this.quietRoomIds = quietOf(snapshot.quiet_rooms);
  }

  /** A painted snapshot is replaced, not patched, by the first live batch. */
  private applyBatches(batches: readonly RoomListBatch[], initial: RoomListItemView[]): void {
    const fresh = !this.live;
    let sections = fresh ? sectionsOf([]) : this.#sections;
    let badges = fresh ? badgesOf([]) : this.#badges;
    let quiet = fresh ? quietOf([]) : this.quietRoomIds;
    for (const { sections: update } of batches) {
      if (!update) continue;
      sections = applySections(sections, update);
      if (update.badges) badges = badgesOf(update.badges);
      if (update.quiet_rooms) quiet = quietOf(update.quiet_rooms);
    }
    this.#sections = sections;
    this.#badges = badges;
    this.quietRoomIds = quiet;
    const diffs = batches.flatMap((batch) => batch.diffs);
    if (!fresh && diffs.length === 0) {
      this.scheduleSnapshotWrite();
      return;
    }
    this.setRooms(applyDiffs(fresh ? initial : this.#source, diffs));
  }

  private snapshot(): RoomListSnapshot {
    return {
      rooms: this.#source,
      sections: [...this.#sections.values()],
      badges: [...this.#badges].map(([room_id, counts]) => ({ room_id, counts })),
      quiet_rooms: [...this.quietRoomIds],
    };
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
    writeRoomListSnapshot(this.snapshotAccountId, this.snapshot());
    this.snapshotDirty = false;
  }

  private stopTypingForNewMessages(rooms: readonly RoomListItemView[]): void {
    if (this.typingUsers.size === 0) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local lookup, never stored
    const previous = new Map(this.#source.map((room) => [room.room_id, room.latest_event]));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt wholesale, never mutated once stored
    const typing = new Map(this.typingUsers);
    for (const room of rooms) {
      const latest = room.latest_event;
      const typers = typing.get(room.room_id);
      if (!typers || !latest?.sender || !previous.has(room.room_id)) continue;
      if (latest.event_id === previous.get(room.room_id)?.event_id) continue;
      const remaining = typers.filter((userId) => userId !== latest.sender);
      if (remaining.length === typers.length) continue;
      if (remaining.length > 0) typing.set(room.room_id, remaining);
      else typing.delete(room.room_id);
    }
    if (
      typing.size !== this.typingUsers.size ||
      [...typing].some(([id, users]) => users !== this.typingUsers.get(id))
    )
      this.typingUsers = typing;
  }

  private setRooms(rooms: RoomListItemView[]): void {
    this.live = true;
    this.stopTypingForNewMessages(rooms);
    this.#source = rooms;
    for (const waiter of this.listedWaiters) {
      if (rooms.some((room) => room.room_id === waiter.roomId)) waiter.resolve();
    }
    this.scheduleSnapshotWrite();
  }
}

export const [useRoomList, provideRoomList] = createContext<RoomList>();
