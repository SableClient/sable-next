import type { SubscriptionId } from '@/generated/SubscriptionId';
import type { TimelineItemView } from '@/generated/TimelineItemView';
import { applyDiffs } from '@/transport';

import type { CoreClient } from '$lib/core/client.svelte';

export type BackwardPaginationState = 'idle' | 'loading' | 'end';
export type ForwardPaginationState = 'idle' | 'loading' | 'end';
export type TimelineMode = { kind: 'live' } | { kind: 'focused'; eventId: string };
type SubscriptionState = 'pending' | 'active' | 'stopped';

const sharedTimelines = new WeakMap<CoreClient, ActiveRoomTimeline>();

export class ActiveRoomTimeline {
  readonly timeline: RoomTimeline;
  private owner: symbol | null = null;

  constructor(core: CoreClient) {
    this.timeline = new RoomTimeline(core);
  }

  async start(owner: symbol, roomId: string, eventId: string | null): Promise<void> {
    this.owner = owner;
    await this.timeline.start(roomId, eventId);
  }

  stop(owner: symbol): Promise<void> {
    if (this.owner !== owner) return Promise.resolve();
    this.owner = null;
    return this.timeline.stop();
  }
}

export function activeRoomTimeline(core: CoreClient): ActiveRoomTimeline {
  let active = sharedTimelines.get(core);
  if (!active) {
    active = new ActiveRoomTimeline(core);
    sharedTimelines.set(core, active);
  }
  return active;
}

export class RoomTimeline {
  items = $state.raw<TimelineItemView[]>([]);
  loading = $state(false);
  backwardPagination = $state<BackwardPaginationState>('idle');
  forwardPagination = $state<ForwardPaginationState>('idle');
  error = $state<string | null>(null);
  mode = $state<TimelineMode>({ kind: 'live' });

  private subscription: SubscriptionId | null = null;
  private target: { roomId: string; eventId: string | null } | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private unsubscribePromise = Promise.resolve();
  private hasPendingUnsubscribe = false;
  private startRequest = 0;
  private session = 0;
  private state: SubscriptionState = 'stopped';
  constructor(private readonly core: CoreClient) {}

  async start(roomId: string, eventId: string | null = null): Promise<void> {
    const target = { roomId, eventId };
    if (this.target?.roomId === roomId && this.target.eventId === eventId) {
      if (this.subscription !== null) return;
      if (this.startPromise) return this.startPromise;
    }

    const request = ++this.startRequest;
    if (this.target !== null) await this.stopCurrent(false);
    if (this.hasPendingUnsubscribe) await this.unsubscribePromise;
    if (request !== this.startRequest) return;

    const session = this.session;
    this.target = target;
    this.mode = eventId === null ? { kind: 'live' } : { kind: 'focused', eventId };
    this.loading = true;
    this.error = null;
    const promise = this.startSubscription(roomId, eventId);
    this.startPromise = promise;

    try {
      await promise;
    } catch {
      if (session === this.session) this.error = 'load_failed';
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
      if (session === this.session) this.loading = false;
    }
  }

  async paginateBackward(count: number): Promise<boolean> {
    const subscription = this.subscription;
    if (subscription === null || this.backwardPagination !== 'idle') return true;

    const session = this.session;
    this.backwardPagination = 'loading';

    try {
      const response = await this.core.paginate(subscription, 'backward', count);
      if (
        this.mode.kind === 'focused' &&
        session === this.session &&
        subscription === this.subscription
      ) {
        this.backwardPagination = response.reached_end ? 'end' : 'idle';
      }
      return response.reached_end;
    } catch {
      if (session === this.session && subscription === this.subscription) {
        this.error = 'load_failed';
        this.backwardPagination = 'idle';
      }
      return true;
    }
  }

  async paginateForward(count: number): Promise<boolean> {
    const subscription = this.subscription;
    if (
      this.mode.kind !== 'focused' ||
      subscription === null ||
      this.forwardPagination !== 'idle'
    ) {
      return true;
    }

    const session = this.session;
    this.forwardPagination = 'loading';
    try {
      const response = await this.core.paginate(subscription, 'forward', count);
      if (session === this.session && subscription === this.subscription) {
        this.forwardPagination = response.reached_end ? 'end' : 'idle';
      }
      return response.reached_end;
    } catch {
      if (session === this.session && subscription === this.subscription) {
        this.error = 'load_failed';
        this.forwardPagination = 'idle';
      }
      return true;
    }
  }

  stop(): Promise<void> {
    return this.stopCurrent(true);
  }

  private stopCurrent(invalidateStart: boolean): Promise<void> {
    if (invalidateStart) this.startRequest += 1;
    this.session += 1;
    this.state = 'stopped';
    this.startPromise = null;
    this.items = [];
    this.loading = false;
    this.backwardPagination = 'idle';
    this.forwardPagination = 'idle';
    this.error = null;
    this.mode = { kind: 'live' };
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;

    const subscription = this.subscription;
    this.subscription = null;
    this.target = null;
    if (subscription !== null) {
      this.hasPendingUnsubscribe = true;
      this.unsubscribePromise = this.unsubscribePromise
        .then(() => this.core.unsubscribe(subscription))
        .catch(() => {})
        .finally(() => {
          this.hasPendingUnsubscribe = false;
        });
    }
    return this.unsubscribePromise;
  }

  private async startSubscription(roomId: string, eventId: string | null): Promise<void> {
    const session = this.session;
    this.state = 'pending';
    const stopEvents = this.core.subscribeEvents((event) => {
      if (event.type !== 'timeline_diff' && event.type !== 'timeline_pagination') return;
      if (
        session !== this.session ||
        this.state !== 'active' ||
        event.subscription !== this.subscription
      )
        return;
      if (event.type === 'timeline_diff') {
        const before = this.items;
        const items = applyDiffs(before, event.diffs);
        this.items = items;
      }
      if (event.type === 'timeline_pagination' && this.mode.kind === 'live') {
        this.backwardPagination = event.loading ? 'loading' : event.reached_start ? 'end' : 'idle';
      }
    });

    let response;
    try {
      response = await this.core.subscribeTimeline(roomId, eventId);
    } catch (error) {
      stopEvents();
      this.state = 'stopped';
      throw error;
    }

    if (session !== this.session) {
      this.core.unsubscribe(response.subscription).catch(() => {});
      stopEvents();
      return;
    }

    this.subscription = response.subscription;
    this.items = response.items;
    this.state = 'active';
    this.unsubscribeEvents = stopEvents;
  }
}
