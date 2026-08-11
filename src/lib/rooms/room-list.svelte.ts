import { createContext } from 'svelte';

import type { CoreEvent } from '@/generated/CoreEvent';
import type { RoomSummary } from '@/generated/RoomSummary';
import type { SubscriptionId } from '@/generated/SubscriptionId';
import { applyDiffs } from '@/transport';

import { bufferSubscription } from '$lib/core/buffered-subscription';
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
    const buffered = bufferSubscription<CoreEvent, RoomListDiffs[number], RoomSummary>(
      (listener) => this.core.subscribeEvents(listener),
      (event) => (event.type === 'room_list_diff' ? event : null),
      applyDiffs,
      (diffs) => (this.rooms = applyDiffs(this.rooms, diffs))
    );

    let response;
    try {
      response = await this.core.subscribeRoomList();
    } catch (error) {
      buffered.stop();
      throw error;
    }

    if (generation !== this.generation) {
      this.core.unsubscribe(response.subscription).catch(() => {});
      buffered.stop();
      return;
    }

    this.subscription = response.subscription;
    this.rooms = buffered.activate(response.subscription, response.rooms);
    this.unsubscribeEvents = buffered.stop;
  }
}

export const [useRoomList, provideRoomList] = createContext<RoomList>();
