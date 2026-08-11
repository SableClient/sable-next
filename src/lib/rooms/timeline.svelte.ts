import type { CoreEvent } from '@/generated/CoreEvent';
import type { SubscriptionId } from '@/generated/SubscriptionId';
import type { TimelineItemView } from '@/generated/TimelineItemView';
import { applyDiffs } from '@/transport';

import { bufferSubscription } from '$lib/core/buffered-subscription';
import type { CoreClient } from '$lib/core/client.svelte';

type TimelineDiffs = Extract<CoreEvent, { type: 'timeline_diff' }>['diffs'];

export type BackwardPaginationState = 'idle' | 'loading' | 'end';

export class RoomTimeline {
  items = $state.raw<TimelineItemView[]>([]);
  loading = $state(false);
  backwardPagination = $state<BackwardPaginationState>('idle');
  error = $state<string | null>(null);

  private subscription: SubscriptionId | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private paginatePromise: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly core: CoreClient) {}

  async start(roomId: string, eventId: string | null = null): Promise<void> {
    if (this.subscription !== null) return;
    if (this.startPromise) return this.startPromise;

    const generation = this.generation;
    this.loading = true;
    this.error = null;
    const promise = this.startSubscription(roomId, eventId);
    this.startPromise = promise;

    try {
      await promise;
    } catch {
      if (generation === this.generation) this.error = 'load_failed';
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
      if (generation === this.generation) this.loading = false;
    }
  }

  async paginate(count: number): Promise<void> {
    const subscription = this.subscription;
    if (subscription === null || this.backwardPagination !== 'idle') return;

    const generation = this.generation;
    this.backwardPagination = 'loading';
    const pagination = this.core.paginate(subscription, count).then((response) => {
      if (generation === this.generation && subscription === this.subscription) {
        this.backwardPagination = response.reached_start ? 'end' : 'idle';
      }
    });
    this.paginatePromise = pagination;

    try {
      await pagination;
    } catch {
      if (generation === this.generation && subscription === this.subscription) {
        this.error = 'load_failed';
        this.backwardPagination = 'idle';
      }
    } finally {
      if (this.paginatePromise === pagination) {
        this.paginatePromise = null;
      }
    }
  }

  stop(): void {
    this.generation += 1;
    this.startPromise = null;
    this.paginatePromise = null;
    this.items = [];
    this.loading = false;
    this.backwardPagination = 'idle';
    this.error = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;

    const subscription = this.subscription;
    this.subscription = null;
    if (subscription !== null) this.core.unsubscribe(subscription).catch(() => {});
  }

  private async startSubscription(roomId: string, eventId: string | null): Promise<void> {
    const generation = this.generation;
    const buffered = bufferSubscription<CoreEvent, TimelineDiffs[number], TimelineItemView>(
      (listener) => this.core.subscribeEvents(listener),
      (event) => (event.type === 'timeline_diff' ? event : null),
      applyDiffs,
      (diffs) => (this.items = applyDiffs(this.items, diffs))
    );

    let response;
    try {
      response = await this.core.subscribeTimeline(roomId, eventId);
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
    this.items = buffered.activate(response.subscription, response.items);
    this.unsubscribeEvents = buffered.stop;
  }
}
