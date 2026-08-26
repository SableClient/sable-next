import { createContext } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { CoreEvent } from '#src/generated/CoreEvent';
import type { NotificationModeView } from '#src/generated/NotificationModeView';
import type { RoomSummary } from '#src/generated/RoomSummary';
import type { SubscriptionId } from '#src/generated/SubscriptionId';
import { applyDiffs } from '#src/transport';

import { bufferSubscription } from '#lib/core/buffered-subscription.js';
import type { CoreClient } from '#lib/core/client.svelte.js';

type RoomListDiffs = Extract<CoreEvent, { type: 'room_list_diff' }>['diffs'];

type RoomNotificationModes = { room: NotificationModeView | null; fallback: NotificationModeView };
const NOTIFICATION_MODE_LOAD_CONCURRENCY = 8;

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

export class RoomList {
  rooms = $state.raw<RoomSummary[]>([]);
  mutedRoomIds = $state.raw<ReadonlySet<string>>(new SvelteSet());
  typingRoomIds = $state.raw<ReadonlySet<string>>(new SvelteSet());

  private subscription: SubscriptionId | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeNotificationSettings: (() => void) | null = null;
  private unsubscribeTyping: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private notificationModes = new SvelteMap<string, RoomNotificationModes>();
  private loadingNotificationModes = new SvelteSet<string>();

  constructor(private readonly core: CoreClient) {}

  notificationOverride(roomId: string): NotificationModeView | null {
    return this.notificationModes.get(roomId)?.room ?? null;
  }

  async start(): Promise<void> {
    if (this.subscription !== null) return;
    if (this.startPromise) return this.startPromise;

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
    this.rooms = [];
    this.mutedRoomIds = new SvelteSet();
    this.typingRoomIds = new SvelteSet();
    this.notificationModes.clear();
    this.loadingNotificationModes.clear();
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
    this.setRooms(buffered.activate(response.subscription, response.rooms));
    this.unsubscribeEvents = buffered.stop;
    this.unsubscribeNotificationSettings = this.core.subscribeEvents((event) => {
      if (event.type === 'notification_settings_changed')
        void this.loadNotificationModes(this.rooms);
    });
    this.unsubscribeTyping = this.core.subscribeEvents((event) => {
      if (event.type !== 'typing') return;

      const rooms = new SvelteSet(this.typingRoomIds);
      if (event.user_ids.length > 0) rooms.add(event.room_id);
      else rooms.delete(event.room_id);
      this.typingRoomIds = rooms;
    });
  }

  private setRooms(rooms: RoomSummary[]): void {
    this.rooms = rooms;
    const roomIds = new SvelteSet(rooms.map((room) => room.room_id));
    for (const roomId of this.notificationModes.keys()) {
      if (!roomIds.has(roomId)) this.notificationModes.delete(roomId);
    }
    void this.loadNotificationModes(
      rooms.filter((room) => !this.notificationModes.has(room.room_id))
    );
  }

  private async loadNotificationModes(rooms: readonly RoomSummary[]): Promise<void> {
    const generation = this.generation;
    const pending = rooms.filter((room) => !this.loadingNotificationModes.has(room.room_id));
    for (const room of pending) this.loadingNotificationModes.add(room.room_id);
    const modes: { roomId: string; mode: RoomNotificationModes }[] = [];
    for (let index = 0; index < pending.length; index += NOTIFICATION_MODE_LOAD_CONCURRENCY) {
      const results = await Promise.allSettled(
        pending.slice(index, index + NOTIFICATION_MODE_LOAD_CONCURRENCY).map(async (room) => {
          const settings = await this.core.commands.notificationSettings(room.room_id);
          return {
            roomId: room.room_id,
            mode: { room: settings.room, fallback: settings.default },
          };
        })
      );
      for (const result of results) {
        if (result.status === 'fulfilled') modes.push(result.value);
      }
    }
    for (const room of pending) this.loadingNotificationModes.delete(room.room_id);
    if (generation !== this.generation) return;

    for (const { roomId, mode } of modes) this.notificationModes.set(roomId, mode);
    this.mutedRoomIds = new SvelteSet(
      [...this.notificationModes]
        .filter(([, mode]) => (mode.room ?? mode.fallback) === 'mute')
        .map(([roomId]) => roomId)
    );
  }
}

export const [useRoomList, provideRoomList] = createContext<RoomList>();
