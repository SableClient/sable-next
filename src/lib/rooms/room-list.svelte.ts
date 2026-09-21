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

import { readRoomListSnapshot, writeRoomListSnapshot } from './room-list-snapshot.js';
import {
  type NotificationModeResolver,
  roomNotifications,
  type RoomUnread,
  roomUnread,
} from './unread.js';

type RoomListDiffs = Extract<CoreEvent, { type: 'room_list_diff' }>['diffs'];

type RoomNotificationModes = { room: NotificationModeView | null; fallback: NotificationModeView };
const NOTIFICATION_MODE_BATCH = 200;
const SNAPSHOT_WRITE_DELAY_MS = 1_000;

export function roomPathId(room: RoomSummary): string {
  return room.canonical_alias ?? room.room_id;
}

/** `resolve()` inserts route parameters verbatim, including `#`. */
export function roomPathParamFromId(roomId: string): string {
  return encodeURIComponent(roomId);
}

export function roomPathParam(room: RoomSummary): string {
  return roomPathParamFromId(roomPathId(room));
}

export function findRoomByPathId(
  rooms: readonly RoomSummary[],
  pathId: string | undefined
): RoomSummary | undefined {
  return rooms.find((room) => room.room_id === pathId || room.canonical_alias === pathId);
}

const NOBODY_TYPING: readonly string[] = [];

export class RoomList {
  rooms = $state.raw<RoomSummary[]>([]);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  typingUsers = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());

  private subscription: SubscriptionId | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeNotificationSettings: (() => void) | null = null;
  private unsubscribeTyping: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  /* eslint-disable svelte/prefer-svelte-reactivity -- rows read the published snapshot, not these */
  private readonly notificationModes = new Map<string, RoomNotificationModes>();
  private readonly loadingNotificationModes = new Set<string>();
  /* eslint-enable svelte/prefer-svelte-reactivity */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
  private publishedModes = $state.raw<ReadonlyMap<string, RoomNotificationModes>>(new Map());
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
  private publishedLoadingModes = $state.raw<ReadonlySet<string>>(new Set());
  private snapshotAccountId: string | null = null;
  private snapshotWriteTimer: ReturnType<typeof setTimeout> | undefined;
  private live = false;

  constructor(private readonly core: CoreClient) {}

  typingUserIds(roomId: string): readonly string[] {
    return this.typingUsers.get(roomId) ?? NOBODY_TYPING;
  }

  notificationOverride(roomId: string): NotificationModeView | null {
    return this.publishedModes.get(roomId)?.room ?? null;
  }

  notificationMode(roomId: string): NotificationModeView | null {
    const mode = this.publishedModes.get(roomId);
    return mode?.room ?? mode?.fallback ?? null;
  }

  readonly notificationModeOf: NotificationModeResolver = (roomId) => this.notificationMode(roomId);

  readonly unreadFor: RoomUnread = (room) =>
    this.notificationModeIsLoading(room.room_id)
      ? { unread: 0, highlight: 0, marked: room.marked_unread, notifying: 0 }
      : roomUnread(room, this.notificationMode(room.room_id));

  readonly notificationsFor: RoomUnread = (room) =>
    this.notificationModeIsLoading(room.room_id)
      ? { unread: 0, highlight: 0, marked: room.marked_unread }
      : roomNotifications(room, this.notificationMode(room.room_id));

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
      this.flushSnapshot();
    });
    this.live = false;
    this.snapshotAccountId = null;
    this.rooms = [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    this.typingUsers = new Map();
    this.notificationModes.clear();
    this.loadingNotificationModes.clear();
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
    this.publishedModes = new Map();
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
    this.publishedLoadingModes = new Set();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeNotificationSettings?.();
    this.unsubscribeNotificationSettings = null;
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
        this.setRooms(applyDiffs(this.rooms, diffs));
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
    this.unsubscribeNotificationSettings = this.core.subscribeEvents((event) => {
      if (event.type === 'notification_settings_changed')
        void this.loadNotificationModes(this.rooms);
    });
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
    if (this.snapshotAccountId === null || this.snapshotWriteTimer !== undefined) return;
    this.snapshotWriteTimer = setTimeout(() => {
      this.flushSnapshot();
    }, SNAPSHOT_WRITE_DELAY_MS);
  }

  private flushSnapshot(): void {
    if (this.snapshotWriteTimer !== undefined) clearTimeout(this.snapshotWriteTimer);
    this.snapshotWriteTimer = undefined;
    if (this.snapshotAccountId === null || !this.live) return;
    writeRoomListSnapshot(this.snapshotAccountId, this.rooms);
  }

  private setRooms(rooms: RoomSummary[]): void {
    this.live = true;
    this.rooms = rooms;
    this.scheduleSnapshotWrite();
    void this.loadNotificationModes(
      rooms.filter((room) => !this.notificationModes.has(room.room_id))
    );
  }

  private async loadNotificationModes(rooms: readonly RoomSummary[]): Promise<void> {
    const generation = this.generation;
    const pending = rooms.filter((room) => !this.loadingNotificationModes.has(room.room_id));
    for (const room of pending) this.loadingNotificationModes.add(room.room_id);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
    this.publishedLoadingModes = new Set(this.loadingNotificationModes);
    const modes: { roomId: string; mode: RoomNotificationModes }[] = [];
    for (let index = 0; index < pending.length; index += NOTIFICATION_MODE_BATCH) {
      const batch = pending
        .slice(index, index + NOTIFICATION_MODE_BATCH)
        .map((room) => room.room_id);
      try {
        for (const entry of await this.core.commands.roomNotificationModes(batch)) {
          modes.push({
            roomId: entry.room_id,
            mode: { room: entry.room, fallback: entry.default },
          });
        }
      } catch (error) {
        console.debug('[sable rooms] notification modes unavailable', error);
      }
    }
    for (const room of pending) this.loadingNotificationModes.delete(room.room_id);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
    this.publishedLoadingModes = new Set(this.loadingNotificationModes);
    if (generation !== this.generation) return;

    for (const { roomId, mode } of modes) this.notificationModes.set(roomId, mode);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
    this.publishedModes = new Map(this.notificationModes);
  }

  private notificationModeIsLoading(roomId: string): boolean {
    return this.publishedLoadingModes.has(roomId) && !this.publishedModes.has(roomId);
  }
}

export const [useRoomList, provideRoomList] = createContext<RoomList>();
