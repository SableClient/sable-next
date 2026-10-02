import type {
  CoreEvent,
  SubscriptionId,
  TimelineFocusView,
  TimelineItemView,
} from '#src/generated/protocol';
import { applyDiffs } from '#src/transport';

import type { CoreClient } from '#lib/core/client.svelte.js';

export type BackwardPaginationState = 'idle' | 'loading' | 'end';
export type ForwardPaginationState = 'idle' | 'loading' | 'end';
export type TimelineMode =
  | { kind: 'live' }
  | { kind: 'unread'; eventId: string }
  | { kind: 'focused'; eventId: string }
  | { kind: 'thread'; rootEventId: string };
type SubscriptionState = 'pending' | 'active' | 'stopped';
const PAGINATION_DIFF_SETTLE_TIMEOUT = 2_000;
const RESUME_PAGE_SIZE = 25;
const MAX_EMPTY_RESUME_PAGES = 5;
const MAX_EMPTY_THREAD_PAGES = 5;

const sharedTimelines = new WeakMap<CoreClient, ActiveRoomTimeline>();

function focusFor(mode: TimelineMode): TimelineFocusView {
  switch (mode.kind) {
    case 'live':
      return { kind: 'live' };
    case 'focused':
    case 'unread':
      return { kind: 'event', event_id: mode.eventId };
    case 'thread':
      return { kind: 'thread', root_event_id: mode.rootEventId };
  }
}

function sameMode(left: TimelineMode, right: TimelineMode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'focused' && right.kind === 'focused') return left.eventId === right.eventId;
  if (left.kind === 'unread' && right.kind === 'unread') return left.eventId === right.eventId;
  if (left.kind === 'thread' && right.kind === 'thread') {
    return left.rootEventId === right.rootEventId;
  }
  return true;
}

export type ResumeAnchor = () => string | null;
const noAnchor: ResumeAnchor = () => null;

function lastEventId(items: readonly TimelineItemView[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].event_id) return items[index].event_id;
  }
  return null;
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
    hiddenEvents = false,
    unread = false
  ): Promise<void> {
    this.owner = owner;
    await this.timeline.start(roomId, eventId, hiddenEvents, unread);
  }

  async startThread(owner: symbol, roomId: string, rootEventId: string): Promise<void> {
    this.owner = owner;
    await this.timeline.startThread(roomId, rootEventId);
  }

  resumeLive(owner: symbol, anchor: ResumeAnchor = noAnchor): Promise<void> {
    if (this.owner !== owner) return Promise.reject(new Error('Timeline owner changed'));
    return this.timeline.resumeLive(anchor);
  }

  async startUnread(
    owner: symbol,
    roomId: string,
    eventId: string,
    hiddenEvents = false
  ): Promise<void> {
    this.owner = owner;
    await this.timeline.startUnread(roomId, eventId, hiddenEvents);
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

export interface ReplyFallback {
  sender: string | null;
  body: string;
}

export class RoomTimeline {
  items = $state.raw<TimelineItemView[]>([]);
  aggregations = $state.raw<TimelineItemView[]>([]);
  loading = $state(false);
  resumingLive = $state(false);
  hasSnapshot = $state(false);
  forwardPagination = $state<ForwardPaginationState>('idle');
  error = $state<string | null>(null);
  mode = $state<TimelineMode>({ kind: 'live' });
  private backwardPaginationState = $state<BackwardPaginationState>('idle');
  private readonly backwardPaginationWaiters: (() => void)[] = [];

  get subscriptionId(): SubscriptionId | null {
    return this.subscription;
  }

  get backwardPagination(): BackwardPaginationState {
    return this.backwardPaginationState;
  }

  set backwardPagination(state: BackwardPaginationState) {
    this.backwardPaginationState = state;
    if (state !== 'loading')
      for (const resolve of this.backwardPaginationWaiters.splice(0)) resolve();
  }

  get canResumeLive(): boolean {
    return this.mode.kind === 'unread' || this.resumingLive;
  }

  get reachesLatest(): boolean {
    return !this.resumingLive && (this.mode.kind === 'live' || this.forwardPagination === 'end');
  }

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
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read only while publishing items, which is what renders
  private readonly replyFallbacks = new Map<string, ReplyFallback>();

  private backwardPaginationStartFirstEventId: string | null = null;
  private backwardPaginationBoundaryChanged = false;
  private backwardPaginationSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private forwardPaginationCompletion: ForwardPaginationState | null = null;
  private forwardPaginationStartLastEventId: string | null = null;
  private forwardPaginationSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private resumePromise: Promise<void> | null = null;
  private stagedItems: TimelineItemView[] | null = null;
  private stagedAggregations: TimelineItemView[] | null = null;
  constructor(private readonly core: CoreClient) {}

  provideReplyFallback(eventId: string, fallback: ReplyFallback): void {
    this.replyFallbacks.set(eventId, fallback);
    this.items = this.withReplyFallbacks(this.items);
  }

  private withReplyFallbacks(items: TimelineItemView[]): TimelineItemView[] {
    if (this.replyFallbacks.size === 0) return items;
    let next: TimelineItemView[] | null = null;
    for (const [index, item] of items.entries()) {
      const reply = item.in_reply_to;
      if (reply?.body !== null) continue;
      const fallback = this.replyFallbacks.get(reply.event_id);
      if (!fallback) continue;
      next ??= [...items];
      next[index] = {
        ...item,
        in_reply_to: { ...reply, sender: reply.sender ?? fallback.sender, body: fallback.body },
      };
    }
    return next ?? items;
  }

  start(
    roomId: string,
    eventId: string | null = null,
    hiddenEvents = false,
    unread = false
  ): Promise<void> {
    return this.open(
      roomId,
      eventId === null ? { kind: 'live' } : { kind: 'focused', eventId },
      hiddenEvents,
      unread
    );
  }

  startThread(roomId: string, rootEventId: string): Promise<void> {
    return this.open(roomId, { kind: 'thread', rootEventId }, false);
  }

  async loadThreadEvent(eventId: string, signal: AbortSignal): Promise<void> {
    const session = this.session;
    let emptyPages = 0;
    while (
      !signal.aborted &&
      session === this.session &&
      this.mode.kind === 'thread' &&
      this.error === null &&
      !this.items.some((item) => item.event_id === eventId) &&
      this.backwardPagination !== 'end' &&
      emptyPages < MAX_EMPTY_THREAD_PAGES
    ) {
      const before = this.items;
      await this.paginateBackward(RESUME_PAGE_SIZE);
      await this.backwardPaginationSettled();
      emptyPages = this.items === before ? emptyPages + 1 : 0;
    }
  }

  startUnread(roomId: string, eventId: string, hiddenEvents = false): Promise<void> {
    return this.open(roomId, { kind: 'unread', eventId }, hiddenEvents);
  }

  resumeLive(anchor: ResumeAnchor = noAnchor): Promise<void> {
    if (this.resumePromise) return this.resumePromise;
    if (!this.canResumeLive) return Promise.resolve();
    const target = this.target;
    if (!target) return Promise.resolve();
    this.resumingLive = true;
    this.error = null;
    const request =
      this.stagedItems === null || this.subscription === null
        ? this.open(target.roomId, { kind: 'live' }, target.hiddenEvents, false, true)
        : Promise.resolve();
    const session = this.session;
    const startRequest = this.startRequest;
    const current = () => session === this.session && startRequest === this.startRequest;
    const task = request
      .then(async () => {
        if (!current()) throw new Error('Room changed while returning to live');
        if (this.error !== null) throw new Error('Unable to load live messages');
        const restored = await this.pageToAnchor(anchor, current);
        if (!current()) throw new Error('Room changed while returning to live');
        this.items = this.stagedItems ?? this.items;
        this.aggregations = this.stagedAggregations ?? this.aggregations;
        this.stagedItems = null;
        this.stagedAggregations = null;
        if (!restored) throw new Error('Unable to restore the reader position');
      })
      .finally(() => {
        if (this.resumePromise === task) this.resumePromise = null;
        if (current()) this.resumingLive = this.stagedItems !== null;
      });
    this.resumePromise = task;
    return task;
  }

  private async open(
    roomId: string,
    mode: TimelineMode,
    hiddenEvents: boolean,
    unread = false,
    preserveSnapshot = false
  ): Promise<void> {
    const target = { roomId, mode, hiddenEvents };
    if (
      !preserveSnapshot &&
      this.target?.roomId === roomId &&
      sameMode(this.target.mode, mode) &&
      this.target.hiddenEvents === hiddenEvents
    ) {
      if (this.subscription !== null) return;
      if (this.startPromise) return this.startPromise.catch(() => {});
    }

    const request = ++this.startRequest;
    if (this.target !== null || this.resumingLive) {
      await this.stopCurrent(false, preserveSnapshot);
    }
    if (this.hasPendingUnsubscribe) await this.unsubscribePromise;
    if (request !== this.startRequest) return;

    const session = this.session;
    this.target = target;
    if (preserveSnapshot) {
      this.stagedItems = [];
      this.stagedAggregations = [];
    }
    this.mode = mode;
    this.forwardPagination = mode.kind === 'thread' ? 'end' : 'idle';
    this.loading = true;
    this.error = null;
    const promise = this.startSubscription(roomId, mode, hiddenEvents, unread);
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
      (this.stagedItems ?? this.items).find((item) => item.event_id)?.event_id ?? null;
    this.backwardPaginationBoundaryChanged = false;
    this.backwardPagination = 'loading';

    try {
      const response = await this.core.commands.paginate(subscription, 'backward', count);
      if (session === this.session && subscription === this.subscription) {
        this.error = null;
        const state = response.reached_end ? 'end' : 'idle';
        if (this.mode.kind === 'focused' || this.mode.kind === 'unread') {
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
    } catch (error) {
      if (session === this.session && subscription === this.subscription) {
        this.backwardPaginationPending = false;
        this.backwardPaginationCompletion = null;
        this.backwardPaginationStartFirstEventId = null;
        this.backwardPaginationBoundaryChanged = false;
        this.clearBackwardPaginationSettleTimer();
        this.error = 'load_failed';
        this.backwardPagination = 'idle';
      }
      throw error;
    }
  }

  async paginateForward(count: number): Promise<boolean> {
    const subscription = this.subscription;
    if (
      this.mode.kind === 'live' ||
      this.mode.kind === 'thread' ||
      subscription === null ||
      this.forwardPagination !== 'idle'
    ) {
      return true;
    }

    const session = this.session;
    this.clearForwardPaginationSettleTimer();
    this.forwardPaginationCompletion = null;
    this.forwardPaginationStartLastEventId = lastEventId(this.items);
    this.forwardPagination = 'loading';
    try {
      const response = await this.core.commands.paginate(subscription, 'forward', count);
      if (session === this.session && subscription === this.subscription) {
        this.error = null;
        this.forwardPaginationCompletion = response.reached_end ? 'end' : 'idle';
        if (!this.settleForwardPagination()) {
          this.forwardPaginationSettleTimer = setTimeout(() => {
            this.forwardPaginationSettleTimer = null;
            this.settleForwardPagination(true);
          }, PAGINATION_DIFF_SETTLE_TIMEOUT);
        }
      }
      return response.reached_end;
    } catch (error) {
      if (session === this.session && subscription === this.subscription) {
        this.forwardPaginationCompletion = null;
        this.forwardPaginationStartLastEventId = null;
        this.clearForwardPaginationSettleTimer();
        this.error = 'load_failed';
        this.forwardPagination = 'idle';
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    return this.stopCurrent(true);
  }

  private stopCurrent(invalidateStart: boolean, preserveSnapshot = false): Promise<void> {
    if (invalidateStart) this.startRequest += 1;
    this.session += 1;
    this.state = 'stopped';
    this.startPromise = null;
    if (!preserveSnapshot) {
      this.items = [];
      this.replyFallbacks.clear();
      this.aggregations = [];
      this.hasSnapshot = false;
      this.resumingLive = false;
    }
    this.stagedItems = null;
    this.stagedAggregations = null;
    this.resumePromise = null;
    this.loading = false;
    this.backwardPaginationPending = false;
    this.backwardPaginationCompletion = null;
    this.backwardPaginationStartFirstEventId = null;
    this.backwardPaginationBoundaryChanged = false;
    this.clearBackwardPaginationSettleTimer();
    this.backwardPagination = 'idle';
    this.forwardPagination = 'idle';
    this.forwardPaginationCompletion = null;
    this.forwardPaginationStartLastEventId = null;
    this.clearForwardPaginationSettleTimer();
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
    hiddenEvents: boolean,
    unread = false
  ): Promise<void> {
    const session = this.session;
    this.state = 'pending';
    const pending: Extract<CoreEvent, { type: 'timeline_diff' }>[] = [];
    const stopEvents = this.core.subscribeEvents((event) => {
      if (
        event.type !== 'timeline_diff' &&
        event.type !== 'timeline_pagination' &&
        event.type !== 'timeline_aggregations'
      )
        return;
      if (event.type === 'timeline_diff' && session === this.session && this.state === 'pending') {
        pending.push(event);
        return;
      }
      if (
        session !== this.session ||
        this.state !== 'active' ||
        event.subscription !== this.subscription
      )
        return;
      if (event.type === 'timeline_diff') {
        const before = this.stagedItems ?? this.items;
        const items = this.withReplyFallbacks(applyDiffs(before, event.diffs));
        if (this.stagedItems !== null) this.stagedItems = items;
        else this.items = items;
        if (event.diffs.some((diff) => diff.op === 'clear' || diff.op === 'reset')) {
          const oldest = items.find((item) => item.event_id !== null)?.timestamp ?? Infinity;
          if (this.stagedAggregations !== null) {
            this.stagedAggregations = this.stagedAggregations.filter(
              (item) => item.timestamp >= oldest
            );
          } else this.aggregations = this.aggregations.filter((item) => item.timestamp >= oldest);
        }
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
        this.settleForwardPagination();
      }
      if (event.type === 'timeline_aggregations') {
        const next = [...(this.stagedAggregations ?? this.aggregations)];
        for (const item of event.items) {
          const index = next.findIndex((entry) => entry.id === item.id);
          if (index === -1) next.push(item);
          else next[index] = item;
        }
        if (event.items.length > 0) {
          if (this.stagedAggregations !== null) this.stagedAggregations = next;
          else this.aggregations = next;
        }
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
      response =
        mode.kind === 'unread'
          ? await this.subscribeUnreadContext(roomId, mode.eventId, hiddenEvents, session, pending)
          : await this.core.commands.subscribeTimeline(roomId, focusFor(mode), hiddenEvents);
      if (
        unread &&
        mode.kind === 'live' &&
        session === this.session &&
        !response.items.some((item) => item.content.kind === 'read_marker')
      ) {
        const eventId = await this.unloadedReadMarker(roomId, response.items);
        if (session === this.session && eventId !== null) {
          await this.core.commands.unsubscribe(response.subscription);
          if (session !== this.session) {
            stopEvents();
            return;
          }
          pending.length = 0;
          this.mode = { kind: 'unread', eventId };
          response = await this.subscribeUnreadContext(
            roomId,
            eventId,
            hiddenEvents,
            session,
            pending
          );
        }
      }
    } catch (error) {
      stopEvents();
      if (session === this.session) this.state = 'stopped';
      throw error;
    }

    if (session !== this.session) {
      this.core.commands.unsubscribe(response.subscription).catch(() => {});
      stopEvents();
      return;
    }

    this.subscription = response.subscription;
    const items = this.withReplyFallbacks(
      applyDiffs(
        response.items,
        pending
          .filter((event) => event.subscription === response.subscription)
          .flatMap((event) => event.diffs)
      )
    );
    if (this.stagedItems !== null) {
      this.stagedItems = items;
      this.stagedAggregations = response.aggregations;
    } else {
      this.items = items;
      this.aggregations = response.aggregations;
    }
    this.hasSnapshot = true;
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

  private async pageToAnchor(anchor: ResumeAnchor, current: () => boolean): Promise<boolean> {
    const missing = () => {
      const eventId = anchor();
      return eventId !== null && !this.stagedItems?.some((item) => item.event_id === eventId);
    };
    let emptyPages = 0;
    while (missing()) {
      if (this.backwardPagination === 'end' || emptyPages >= MAX_EMPTY_RESUME_PAGES) return false;
      const before = this.stagedItems?.find((item) => item.event_id)?.event_id;
      await this.paginateBackward(RESUME_PAGE_SIZE);
      await this.backwardPaginationSettled();
      if (!current()) return false;
      const after = this.stagedItems?.find((item) => item.event_id)?.event_id;
      emptyPages = before === after ? emptyPages + 1 : 0;
    }
    return true;
  }

  private async unloadedReadMarker(
    roomId: string,
    items: readonly TimelineItemView[]
  ): Promise<string | null> {
    const content = await this.core.commands
      .roomAccountData(roomId, 'm.fully_read')
      .catch(() => null);
    const eventId = (content as { event_id?: unknown } | null)?.event_id;
    if (typeof eventId !== 'string' || items.some((item) => item.event_id === eventId)) {
      return null;
    }
    return eventId;
  }

  private async subscribeUnreadContext(
    roomId: string,
    eventId: string,
    hiddenEvents: boolean,
    session: number,
    pending: unknown[]
  ): ReturnType<CoreClient['commands']['subscribeTimeline']> {
    try {
      return await this.core.commands.subscribeTimeline(
        roomId,
        { kind: 'event', event_id: eventId },
        hiddenEvents
      );
    } catch (error) {
      if (session !== this.session) throw error;
      pending.length = 0;
      this.mode = { kind: 'live' };
      return this.core.commands.subscribeTimeline(roomId, { kind: 'live' }, hiddenEvents);
    }
  }

  private backwardPaginationSettled(): Promise<void> {
    if (this.backwardPagination !== 'loading') return Promise.resolve();
    return new Promise((resolve) => this.backwardPaginationWaiters.push(resolve));
  }

  private clearBackwardPaginationSettleTimer(): void {
    if (this.backwardPaginationSettleTimer === null) return;
    clearTimeout(this.backwardPaginationSettleTimer);
    this.backwardPaginationSettleTimer = null;
  }

  private settleForwardPagination(force = false): boolean {
    const completion = this.forwardPaginationCompletion;
    if (completion === null) return false;
    if (!force && lastEventId(this.items) === this.forwardPaginationStartLastEventId) return false;
    this.forwardPaginationCompletion = null;
    this.forwardPaginationStartLastEventId = null;
    this.clearForwardPaginationSettleTimer();
    this.forwardPagination = completion;
    return true;
  }

  private clearForwardPaginationSettleTimer(): void {
    if (this.forwardPaginationSettleTimer === null) return;
    clearTimeout(this.forwardPaginationSettleTimer);
    this.forwardPaginationSettleTimer = null;
  }
}
