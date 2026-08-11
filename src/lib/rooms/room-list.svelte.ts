import { createContext } from 'svelte';

import type { CoreEvent } from '@/generated/CoreEvent';
import type { RoomSummary } from '@/generated/RoomSummary';
import type { SubscriptionId } from '@/generated/SubscriptionId';
import { applyDiffs } from '@/transport';

import type { CoreClient } from '$lib/core/client.svelte';

type RoomListDiffs = Extract<CoreEvent, { type: 'room_list_diff' }>['diffs'];

export function roomPathId(room: RoomSummary): string {
  return room.canonical_alias ?? room.room_id;
}

/** `resolve()` inserts route parameters verbatim, including `#`. */
export function roomPathParam(room: RoomSummary): string {
  return encodeURIComponent(roomPathId(room));
}

export function findRoomByPathId(
  rooms: readonly RoomSummary[],
  pathId: string | undefined
): RoomSummary | undefined {
  return rooms.find((room) => room.room_id === pathId || room.canonical_alias === pathId);
}

export class RoomList {
  rooms = $state.raw<RoomSummary[]>([]);

  private subscription: SubscriptionId | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly core: CoreClient) {}

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
    this.rooms = [];
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;

    const subscription = this.subscription;
    this.subscription = null;
    if (subscription !== null) this.core.unsubscribe(subscription).catch(() => {});
  }

  private async startSubscription(): Promise<void> {
    const generation = this.generation;
    let subscription: SubscriptionId | null = null;
    const bufferedDiffs: Array<{ subscription: SubscriptionId; diffs: RoomListDiffs }> = [];
    const unsubscribeEvents = this.core.subscribeEvents((event) => {
      if (event.type !== 'room_list_diff') return;

      if (subscription === null) {
        const buffered = bufferedDiffs.find((entry) => entry.subscription === event.subscription);
        if (buffered) buffered.diffs = [...buffered.diffs, ...event.diffs];
        else bufferedDiffs.push({ subscription: event.subscription, diffs: event.diffs });
        return;
      }

      if (event.subscription === subscription) {
        this.rooms = applyDiffs(this.rooms, event.diffs);
      }
    });

    let response;
    try {
      response = await this.core.subscribeRoomList();
    } catch (error) {
      unsubscribeEvents();
      throw error;
    }

    subscription = response.subscription;

    if (generation !== this.generation) {
      this.core.unsubscribe(subscription).catch(() => {});
      unsubscribeEvents();
      return;
    }

    this.subscription = subscription;
    const buffered = bufferedDiffs.find((entry) => entry.subscription === subscription);
    this.rooms = applyDiffs(response.rooms, buffered?.diffs ?? []);
    this.unsubscribeEvents = unsubscribeEvents;
  }
}

export const [useRoomList, provideRoomList] = createContext<RoomList>();
