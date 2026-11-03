import type {
  CoreEvent,
  SubscriptionId,
  TimelineFocusView,
  TimelineItemView,
  RpcResult,
  Rpc,
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
type TimelineSnapshot = Pick<RoomTimeline, 'items' | 'aggregations' | 'readMarkerEventId'>;

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

export class ActiveRoomTimeline {
  readonly timeline: RoomTimeline;
  private owner: symbol | null = null;

  constructor(core: CoreClient) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- inactive snapshots are not rendered
    this.timeline = new RoomTimeline(core, new Map());
  }

  start(
    owner: symbol,
    roomId: string,
    eventId: string | null,
    hiddenEvents = false,
    unread = false,
    landing: string | null = null
  ): Promise<void> {
    this.owner = owner;
    return this.timeline.start(roomId, eventId, hiddenEvents, unread, landing);
  }

  resumeLive(owner: symbol): Promise<void> {
    if (this.owner !== owner) return Promise.reject(new Error('Timeline owner changed'));
    return this.timeline.resumeLive();
  }

  startUnread(owner: symbol, roomId: string, eventId: string, hiddenEvents = false): Promise<void> {
    this.owner = owner;
    return this.timeline.startUnread(roomId, eventId, hiddenEvents);
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

export function clearRoomTimelines(core: CoreClient): void {
  sharedTimelines.get(core)?.timeline.clearCache();
  sharedTimelines.delete(core);
}

export class RoomTimeline {
  items = $state.raw<TimelineItemView[]>([]);
  aggregations = $state.raw<TimelineItemView[]>([]);
  loading = $state(false);
  resumingLive = $state(false);
  private failedPagination: 'backward' | 'forward' | null = null;
  hasSnapshot = $state(false);
  readMarkerEventId = $state<string | null>(null);
  forwardPagination = $state<ForwardPaginationState>('idle');
  error = $state<string | null>(null);
  mode = $state.raw<TimelineMode>({ kind: 'live' });
  backwardPagination = $state<BackwardPaginationState>('idle');

  get subscriptionId(): SubscriptionId | null {
    return this.subscription;
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
  private session = 0;
  private paginationGeneration = 0;
  private resumePromise: Promise<void> | null = null;
  constructor(
    private readonly core: CoreClient,
    private readonly snapshots?: Map<string, TimelineSnapshot>
  ) {}

  clearCache(): void {
    this.snapshots?.clear();
  }

  start(
    roomId: string,
    eventId: string | null = null,
    hiddenEvents = false,
    unread = false,
    landing: string | null = null
  ): Promise<void> {
    return this.open(
      roomId,
      eventId === null ? { kind: 'live' } : { kind: 'focused', eventId },
      hiddenEvents,
      unread,
      false,
      landing
    );
  }

  startThread(roomId: string, rootEventId: string): Promise<void> {
    return this.open(roomId, { kind: 'thread', rootEventId }, false);
  }

  async retry(): Promise<void> {
    if (this.failedPagination !== null && this.subscription !== null) {
      await (
        this.failedPagination === 'backward' ? this.paginateBackward(25) : this.paginateForward(25)
      ).catch(() => {});
      return;
    }
    const target = this.target;
    if (target) await this.open(target.roomId, target.mode, target.hiddenEvents, false, true);
  }

  startUnread(roomId: string, eventId: string, hiddenEvents = false): Promise<void> {
    return this.open(roomId, { kind: 'unread', eventId }, hiddenEvents);
  }

  resumeLive(): Promise<void> {
    if (this.resumePromise) return this.resumePromise;
    if (!this.canResumeLive) return Promise.resolve();
    const target = this.target;
    if (!target) return Promise.resolve();
    const task = this.open(target.roomId, { kind: 'live' }, target.hiddenEvents, false, true)
      .then(() => {
        if (this.resumePromise !== task) throw new Error('Room changed while returning to live');
        if (this.error !== null) throw new Error('Unable to load live messages');
      })
      .finally(() => {
        if (this.resumePromise !== task) return;
        this.resumePromise = null;
        this.resumingLive = false;
      });
    this.resumingLive = true;
    this.resumePromise = task;
    return task;
  }

  private async open(
    roomId: string,
    mode: TimelineMode,
    hiddenEvents: boolean,
    unread = false,
    force = false,
    landing: string | null = null
  ): Promise<void> {
    const target = { roomId, mode, hiddenEvents };
    if (
      !force &&
      this.target?.roomId === roomId &&
      (sameMode(this.target.mode, mode) || sameMode(this.mode, mode)) &&
      this.target.hiddenEvents === hiddenEvents
    ) {
      if (this.subscription !== null) return;
      if (this.startPromise) return this.startPromise.catch(() => {});
    }

    if (this.target !== null || this.resumingLive) void this.stopCurrent(force);

    const key = `${roomId}/${hiddenEvents}`;
    const snapshot =
      !force && mode.kind === 'live' && landing === null ? this.snapshots?.get(key) : undefined;
    this.snapshots?.delete(key);
    if (
      snapshot &&
      (!unread ||
        (snapshot.readMarkerEventId !== null &&
          snapshot.readMarkerEventId === snapshot.items.at(-1)?.event_id))
    ) {
      Object.assign(this, snapshot);
      this.hasSnapshot = true;
    }

    const session = this.session;
    this.target = target;
    this.failedPagination = null;
    this.mode = mode;
    if (mode.kind === 'unread') this.readMarkerEventId = mode.eventId;
    this.forwardPagination = mode.kind === 'thread' ? 'end' : 'idle';
    this.loading = true;
    this.error = null;
    const promise = this.startSubscription(roomId, mode, hiddenEvents, unread, landing);
    this.startPromise = promise;

    try {
      await promise;
    } catch {
      if (session === this.session) {
        this.error = 'load_failed';
        if (force) this.clearContent();
      }
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
      if (session === this.session) this.loading = false;
    }
  }

  paginateBackward(count: number): Promise<boolean> {
    const subscription = this.subscription;
    if (subscription === null || this.backwardPagination !== 'idle') {
      return Promise.resolve(this.backwardPagination === 'end');
    }
    return this.paginate(subscription, 'backward', count);
  }

  paginateForward(count: number): Promise<boolean> {
    const subscription = this.subscription;
    if (
      this.mode.kind === 'live' ||
      this.mode.kind === 'thread' ||
      subscription === null ||
      this.forwardPagination !== 'idle'
    ) {
      return Promise.resolve(true);
    }
    return this.paginate(subscription, 'forward', count);
  }

  private async paginate(
    subscription: SubscriptionId,
    direction: 'backward' | 'forward',
    count: number
  ): Promise<boolean> {
    const state = direction === 'backward' ? 'backwardPagination' : 'forwardPagination';
    const session = this.session;
    const generation = this.paginationGeneration;
    const current = () =>
      session === this.session &&
      subscription === this.subscription &&
      generation === this.paginationGeneration;
    this[state] = 'loading';
    try {
      const response = await this.core.rpc.timeline.paginate({ subscription, direction, count });
      if (current()) {
        this.error = null;
        this.failedPagination = null;
        this[state] = response.reached_end ? 'end' : 'idle';
      }
      return response.reached_end;
    } catch (error) {
      if (current()) {
        this.error = 'load_failed';
        this.failedPagination = direction;
        this[state] = 'idle';
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    return this.stopCurrent();
  }

  private clearContent(): void {
    this.items = [];
    this.aggregations = [];
    this.hasSnapshot = false;
  }

  private async stopCurrent(keepContent = false): Promise<void> {
    if (
      this.snapshots &&
      this.target &&
      this.mode.kind === 'live' &&
      this.hasSnapshot &&
      !this.resumingLive
    ) {
      const key = `${this.target.roomId}/${this.target.hiddenEvents}`;
      this.snapshots.delete(key);
      this.snapshots.set(key, {
        items: this.items.slice(-80),
        aggregations: this.aggregations.slice(-80),
        readMarkerEventId: this.readMarkerEventId,
      });
      const oldest = this.snapshots.keys().next().value;
      if (this.snapshots.size > 8 && oldest !== undefined) this.snapshots.delete(oldest);
    }
    this.session += 1;
    this.startPromise = null;
    if (!keepContent) this.clearContent();
    this.readMarkerEventId = null;
    this.resumingLive = false;
    this.resumePromise = null;
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
      await this.core.rpc.timeline.unsubscribe({ subscription }).catch((error: unknown) => {
        console.debug('[sable timeline] timeline not unsubscribed', error);
      });
    }
  }

  private async startSubscription(
    roomId: string,
    mode: TimelineMode,
    hiddenEvents: boolean,
    unread = false,
    landing: string | null = null
  ): Promise<void> {
    const session = this.session;
    const pending: Extract<CoreEvent, { type: 'timeline_diff' }>[] = [];
    const stopEvents = this.core.subscribeEvents((event) => {
      if (
        event.type !== 'timeline_diff' &&
        event.type !== 'timeline_pagination' &&
        event.type !== 'timeline_aggregations'
      )
        return;
      if (
        event.type === 'timeline_diff' &&
        session === this.session &&
        this.subscription === null
      ) {
        pending.push(event);
        return;
      }
      if (session !== this.session || event.subscription !== this.subscription) return;
      if (event.type === 'timeline_diff') {
        const before = this.items;
        const items = applyDiffs(before, event.diffs);
        this.items = items;
        if (event.diffs.some((diff) => diff.op === 'clear' || diff.op === 'reset')) {
          const oldest = items.find((item) => item.event_id !== null)?.timestamp ?? Infinity;
          this.aggregations = this.aggregations.filter((item) => item.timestamp >= oldest);
        }
        if (before.length > 0 && items.length === 0) {
          this.paginationGeneration += 1;
          this.backwardPagination = 'idle';
          if (this.forwardPagination === 'loading') this.forwardPagination = 'idle';
        }
      }
      if (event.type === 'timeline_aggregations') {
        const next = [...this.aggregations];
        for (const item of event.items) {
          const index = next.findIndex((entry) => entry.id === item.id);
          if (index === -1) next.push(item);
          else next[index] = item;
        }
        if (event.items.length > 0) this.aggregations = next;
      }
      if (event.type === 'timeline_pagination' && this.mode.kind === 'live') {
        this.backwardPagination = event.loading ? 'loading' : event.reached_start ? 'end' : 'idle';
      }
    });

    let response;
    try {
      response =
        mode.kind === 'unread'
          ? await this.subscribeUnreadContext(roomId, mode.eventId, hiddenEvents, session, pending)
          : await this.core.rpc.timeline.subscribe({
              room_id: roomId,
              focus: focusFor(mode),
              hidden_events: hiddenEvents,
            });
      const snapshot = response.items;
      const loaded = (eventId: string) => snapshot.some((item) => item.event_id === eventId);
      let eventId: string | null = null;
      if (mode.kind === 'live' && landing !== null) {
        eventId = loaded(landing) ? null : landing;
      } else if (
        unread &&
        mode.kind === 'live' &&
        session === this.session &&
        !snapshot.some((item) => item.content.kind === 'read_marker')
      ) {
        const marker = await this.readMarker(roomId);
        if (session === this.session) this.readMarkerEventId = marker;
        eventId = marker !== null && !loaded(marker) ? marker : null;
      }
      if (session === this.session && eventId !== null) {
        const live = response;
        this.mode = { kind: 'unread', eventId };
        this.readMarkerEventId = eventId;
        try {
          response = await this.subscribeUnreadContext(
            roomId,
            eventId,
            hiddenEvents,
            session,
            pending,
            live
          );
        } finally {
          if (response !== live || session !== this.session) {
            await this.core.rpc.timeline
              .unsubscribe({ subscription: live.subscription })
              .catch((error: unknown) => {
                console.debug('[sable timeline] live timeline not unsubscribed', error);
              });
          }
        }
      }
    } catch (error) {
      stopEvents();
      throw error;
    }

    if (session !== this.session) {
      this.core.rpc.timeline
        .unsubscribe({ subscription: response.subscription })
        .catch((error: unknown) => {
          console.debug('[sable timeline] stale timeline not unsubscribed', error);
        });
      stopEvents();
      return;
    }

    this.subscription = response.subscription;
    this.items = applyDiffs(
      response.items,
      pending
        .filter((event) => event.subscription === response.subscription)
        .flatMap((event) => event.diffs)
    );
    this.aggregations = response.aggregations;
    this.hasSnapshot = true;
    this.unsubscribeEvents = stopEvents;
  }

  private readMarker(roomId: string): Promise<string | null> {
    return this.core.rpc.timeline.readMarker({ room_id: roomId }).catch((error: unknown) => {
      console.debug('[sable timeline] read marker not loaded', error);
      return null;
    });
  }

  private async subscribeUnreadContext(
    roomId: string,
    eventId: string,
    hiddenEvents: boolean,
    session: number,
    pending: unknown[],
    live?: RpcResult<Rpc['timeline']['subscribe']>
  ): Promise<RpcResult<Rpc['timeline']['subscribe']>> {
    try {
      return await this.core.rpc.timeline.subscribe({
        room_id: roomId,
        focus: { kind: 'event', event_id: eventId },
        hidden_events: hiddenEvents,
      });
    } catch (error) {
      if (session !== this.session) throw error;
      this.mode = { kind: 'live' };
      if (live) return live;
      pending.length = 0;
      return this.core.rpc.timeline.subscribe({
        room_id: roomId,
        focus: { kind: 'live' },
        hidden_events: hiddenEvents,
      });
    }
  }
}
