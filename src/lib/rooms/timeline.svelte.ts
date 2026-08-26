import type { SubscriptionId } from '#src/generated/SubscriptionId';
import type { TimelineItemView } from '#src/generated/TimelineItemView';
import { applyDiffs } from '#src/transport';

import type { CoreClient } from '#lib/core/client.svelte.js';

export type BackwardPaginationState = 'idle' | 'loading' | 'end';
export type ForwardPaginationState = 'idle' | 'loading' | 'end';
export type TimelineMode = { kind: 'live' } | { kind: 'focused'; eventId: string };
type SubscriptionState = 'pending' | 'active' | 'stopped';
const PAGINATION_DIFF_SETTLE_TIMEOUT = 2_000;

const sharedTimelines = new WeakMap<CoreClient, ActiveRoomTimeline>();

export class ActiveRoomTimeline {
  readonly timeline: RoomTimeline;
  private owner: symbol | null = null;

  constructor(core: CoreClient) {
    this.timeline = new RoomTimeline(core);
  }

  async start(
    owner: symbol,
    roomId: string,
    eventId: string | null,
    hiddenEvents = false
  ): Promise<void> {
    this.owner = owner;
    await this.timeline.start(roomId, eventId, hiddenEvents);
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
  private target: { roomId: string; eventId: string | null; hiddenEvents: boolean } | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private unsubscribePromise = Promise.resolve();
  private hasPendingUnsubscribe = false;
  private startRequest = 0;
  private session = 0;
  private state: SubscriptionState = 'stopped';
  private backwardPaginationPending = false;
  private backwardPaginationCompletion: BackwardPaginationState | null = null;
  private backwardPaginationStartFirstEventId: string | null = null;
  private backwardPaginationBoundaryChanged = false;
  private backwardPaginationSettleTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly core: CoreClient) {}

  async start(roomId: string, eventId: string | null = null, hiddenEvents = false): Promise<void> {
    const target = { roomId, eventId, hiddenEvents };
    if (
      this.target?.roomId === roomId &&
      this.target.eventId === eventId &&
      this.target.hiddenEvents === hiddenEvents
    ) {
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
    const promise = this.startSubscription(roomId, eventId, hiddenEvents);
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
    if (subscription === null || this.backwardPagination !== 'idle') {
      return this.backwardPagination === 'end';
    }

    const session = this.session;
    this.clearBackwardPaginationSettleTimer();
    this.backwardPaginationPending = true;
    this.backwardPaginationCompletion = null;
    this.backwardPaginationStartFirstEventId =
      this.items.find((item) => item.event_id)?.event_id ?? null;
    this.backwardPaginationBoundaryChanged = false;
    this.backwardPagination = 'loading';

    try {
      const response = await this.core.commands.paginate(subscription, 'backward', count);
      if (session === this.session && subscription === this.subscription) {
        const state = response.reached_end ? 'end' : 'idle';
        if (this.mode.kind === 'focused') {
          this.backwardPaginationPending = false;
          this.backwardPaginationStartFirstEventId = null;
          this.backwardPaginationBoundaryChanged = false;
          this.backwardPagination = state;
        } else {
          this.backwardPaginationCompletion = state;
          if (!this.settleBackwardPagination()) {
            this.backwardPaginationSettleTimer = setTimeout(() => {
              this.backwardPaginationSettleTimer = null;
              this.settleBackwardPagination(true);
            }, PAGINATION_DIFF_SETTLE_TIMEOUT);
          }
        }
      }
      return response.reached_end;
    } catch {
      if (session === this.session && subscription === this.subscription) {
        this.backwardPaginationPending = false;
        this.backwardPaginationCompletion = null;
        this.backwardPaginationStartFirstEventId = null;
        this.backwardPaginationBoundaryChanged = false;
        this.clearBackwardPaginationSettleTimer();
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
      const response = await this.core.commands.paginate(subscription, 'forward', count);
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
    this.backwardPaginationPending = false;
    this.backwardPaginationCompletion = null;
    this.backwardPaginationStartFirstEventId = null;
    this.backwardPaginationBoundaryChanged = false;
    this.clearBackwardPaginationSettleTimer();
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
        .then(() => this.core.commands.unsubscribe(subscription))
        .catch(() => {})
        .finally(() => {
          this.hasPendingUnsubscribe = false;
        });
    }
    return this.unsubscribePromise;
  }

  private async startSubscription(
    roomId: string,
    eventId: string | null,
    hiddenEvents: boolean
  ): Promise<void> {
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
        if (before.length > 0 && items.length === 0) {
          this.backwardPaginationPending = false;
          this.backwardPaginationCompletion = null;
          this.backwardPaginationStartFirstEventId = null;
          this.backwardPaginationBoundaryChanged = false;
          this.clearBackwardPaginationSettleTimer();
          this.backwardPagination = 'idle';
        }
        const firstEventId = items.find((item) => item.event_id)?.event_id ?? null;
        this.backwardPaginationBoundaryChanged ||=
          firstEventId !== this.backwardPaginationStartFirstEventId;
        this.settleBackwardPagination();
      }
      if (event.type === 'timeline_pagination' && this.mode.kind === 'live') {
        if (event.loading || !this.backwardPaginationPending) {
          this.backwardPagination = event.loading
            ? 'loading'
            : event.reached_start
              ? 'end'
              : 'idle';
        }
      }
    });

    let response;
    try {
      response = await this.core.commands.subscribeTimeline(roomId, eventId, hiddenEvents);
    } catch (error) {
      stopEvents();
      this.state = 'stopped';
      throw error;
    }

    if (session !== this.session) {
      this.core.commands.unsubscribe(response.subscription).catch(() => {});
      stopEvents();
      return;
    }

    this.subscription = response.subscription;
    this.items = response.items;
    this.state = 'active';
    this.unsubscribeEvents = stopEvents;
  }

  private settleBackwardPagination(force = false): boolean {
    const completion = this.backwardPaginationCompletion;
    if (!this.backwardPaginationPending || !completion) return false;
    if (!force && !this.backwardPaginationBoundaryChanged) return false;

    this.backwardPaginationPending = false;
    this.backwardPaginationCompletion = null;
    this.backwardPaginationStartFirstEventId = null;
    this.backwardPaginationBoundaryChanged = false;
    this.clearBackwardPaginationSettleTimer();
    this.backwardPagination = completion;
    return true;
  }

  private clearBackwardPaginationSettleTimer(): void {
    if (this.backwardPaginationSettleTimer === null) return;
    clearTimeout(this.backwardPaginationSettleTimer);
    this.backwardPaginationSettleTimer = null;
  }
}
