import type { SubscriptionId } from '#src/generated/SubscriptionId';
import type { TimelineFocusView } from '#src/generated/TimelineFocusView';
import type { TimelineItemView } from '#src/generated/TimelineItemView';
import { applyDiffs } from '#src/transport';

import type { CoreClient } from '#lib/core/client.svelte.js';

export type BackwardPaginationState = 'idle' | 'loading' | 'end';
export type ForwardPaginationState = 'idle' | 'loading' | 'end';
export type TimelineMode =
  | { kind: 'live' }
  | { kind: 'focused'; eventId: string }
  | { kind: 'thread'; rootEventId: string };
type SubscriptionState = 'pending' | 'active' | 'stopped';
const PAGINATION_DIFF_SETTLE_TIMEOUT = 2_000;

const sharedTimelines = new WeakMap<CoreClient, ActiveRoomTimeline>();

function focusFor(mode: TimelineMode): TimelineFocusView {
  switch (mode.kind) {
    case 'live':
      return { kind: 'live' };
    case 'focused':
      return { kind: 'event', event_id: mode.eventId };
    case 'thread':
      return { kind: 'thread', root_event_id: mode.rootEventId };
  }
}

function sameMode(left: TimelineMode, right: TimelineMode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'focused' && right.kind === 'focused') return left.eventId === right.eventId;
  if (left.kind === 'thread' && right.kind === 'thread') {
    return left.rootEventId === right.rootEventId;
  }
  return true;
}

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

  async startThread(owner: symbol, roomId: string, rootEventId: string): Promise<void> {
    this.owner = owner;
    await this.timeline.startThread(roomId, rootEventId);
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
  private target: { roomId: string; mode: TimelineMode; hiddenEvents: boolean } | null = null;
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

  start(roomId: string, eventId: string | null = null, hiddenEvents = false): Promise<void> {
    return this.open(
      roomId,
      eventId === null ? { kind: 'live' } : { kind: 'focused', eventId },
      hiddenEvents
    );
  }

  startThread(roomId: string, rootEventId: string): Promise<void> {
    return this.open(roomId, { kind: 'thread', rootEventId }, false);
  }

  private async open(roomId: string, mode: TimelineMode, hiddenEvents: boolean): Promise<void> {
    const target = { roomId, mode, hiddenEvents };
    if (
      this.target?.roomId === roomId &&
      sameMode(this.target.mode, mode) &&
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
    this.mode = mode;
    this.loading = true;
    this.error = null;
    const promise = this.startSubscription(roomId, mode, hiddenEvents);
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
    mode: TimelineMode,
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
      response = await this.core.commands.subscribeTimeline(roomId, focusFor(mode), hiddenEvents);
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
