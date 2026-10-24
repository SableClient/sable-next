import type { ResolvedItem, ResolvedRow } from '#lib/rooms/timeline-item.js';
import type {
  PaginationStateView,
  SubscriptionId,
  TimelineAction,
  TimelineDocView,
  TimelineModeView,
  TimelinePaginated,
  TimelineUnreadView,
} from '#src/generated/protocol';

import { resolveItem, resolveRow } from '#lib/rooms/timeline-item.js';
import { runtime } from '#lib/runtime/app.js';
import type { Client } from '#lib/runtime/client.js';
import { SliceHandle } from '#lib/runtime/handle.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const NO_ROWS: readonly ResolvedRow[] = [];
const NO_ITEMS: readonly ResolvedItem[] = [];
// A window ending at u32::MAX follows new rows.
const FOLLOWING = 4_294_967_295;
// Count the rows before fetching the first window.
const PARKED = { start: FOLLOWING - 1, end: FOLLOWING };
// Start with this many rows at the tail.
const TAIL_ROWS = 80;
// Keep this many rows above the viewport for scrolling back.
const ROWS_ABOVE = 120;
// Near the start, keep the whole prefix to avoid small window moves.
const NEAR_TOP = 160;
const TRIM_AFTER = 240;
const LIVE: TimelineModeView = { kind: 'live' };
export const NO_UNREAD: TimelineUnreadView = {
  initialized: false,
  loading: false,
  active: false,
  first_event_id: null,
  read_event_id: null,
  failed: false,
  count: 0,
  blocking: true,
};

let nextView = 0;

function sameMode(left: TimelineModeView, right: TimelineModeView): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'thread' && right.kind === 'thread')
    return left.root_event_id === right.root_event_id;
  if ('event_id' in left && 'event_id' in right) return left.event_id === right.event_id;
  return true;
}

type Replies = Record<Exclude<TimelineAction['type'], 'paginate'>, null> & {
  paginate: TimelinePaginated;
};

type Handle = SliceHandle<'timeline', Replies>;

export interface TimelineShown {
  readOnly: boolean;
  threadRoot: string | null;
}

export class RoomTimeline {
  private served = $state.raw<TimelineDocView | undefined>(undefined);
  private readonly ready: boolean = $derived(this.served !== undefined);
  private handle: Handle | null = null;
  private roomId: string | null = null;
  private generation = 0;
  private release: (() => void)[] = [];
  private shown: TimelineShown = { readOnly: false, threadRoot: null };
  private readonly view = `view-${String(++nextView)}-${Math.random().toString(36).slice(2)}`;
  private attaching: Promise<void> | null = null;
  private openToken = 0;
  private shownMode: TimelineModeView = LIVE;

  constructor(
    private readonly connect: () => Promise<Client> = runtime,
    // Hold only rows near the viewport and all newer rows.
    private readonly windowed = false
  ) {}

  protected get doc(): TimelineDocView | undefined {
    return this.served;
  }

  readonly rows: readonly ResolvedRow[] = $derived(this.doc?.items.map(resolveRow) ?? NO_ROWS);

  readonly total: number = $derived(this.doc?.total ?? 0);

  readonly first: number = $derived(this.total - this.rows.length);

  readonly items: readonly ResolvedItem[] = $derived(
    this.doc?.events?.items.map(resolveItem) ??
      this.rows.flatMap((row) => row.group?.map(({ item }) => item) ?? [row.item])
  );

  /** What the core holds, before the reader's filters. */
  readonly itemCount: number = $derived(this.doc?.status.item_count ?? 0);

  readonly aggregations: readonly ResolvedItem[] = $derived(
    this.doc?.aggregations.items.map(resolveItem) ?? NO_ITEMS
  );

  readonly loading: boolean = $derived(this.doc?.status.loading ?? false);

  readonly resumingLive: boolean = $derived(this.doc?.status.resuming_live ?? false);

  readonly hasSnapshot: boolean = $derived(this.doc?.status.has_snapshot ?? false);

  readonly forwardPagination: PaginationStateView = $derived(
    this.doc?.status.forward_pagination ?? 'idle'
  );

  readonly backwardPagination: PaginationStateView = $derived(
    this.doc?.status.backward_pagination ?? 'idle'
  );

  readonly error: string | null = $derived(this.doc?.status.error ?? null);

  /** The same object until the mode changes, as callers compare it by identity. */
  readonly mode: TimelineModeView = $derived.by(() => {
    const mode = this.doc?.status.mode;
    if (!mode) return LIVE;
    if (!sameMode(this.shownMode, mode)) this.shownMode = mode;
    return this.shownMode;
  });

  readonly subscriptionId: SubscriptionId | null = $derived(this.doc?.status.subscription ?? null);

  readonly canResumeLive: boolean = $derived(this.doc?.status.can_resume_live ?? false);

  readonly reachesLatest: boolean = $derived(this.doc?.status.reaches_latest ?? true);

  readonly latestEventId: string | null = $derived(this.doc?.status.latest_event_id ?? null);

  readonly unread: TimelineUnreadView = $derived(this.doc?.status.unread ?? NO_UNREAD);

  show(shown: TimelineShown): void {
    this.shown = shown;
    this.configure();
  }

  start(
    roomId: string,
    eventId: string | null = null,
    hiddenEvents = false,
    unread = false,
    landing: string | null = null,
    hasUnread = false
  ): Promise<void> {
    return this.open(roomId, {
      type: 'open',
      target: eventId === null ? { kind: 'live' } : { kind: 'focused', event_id: eventId },
      hidden_events: hiddenEvents,
      unread,
      has_unread: hasUnread,
      landing,
    });
  }

  startThread(roomId: string, rootEventId: string): Promise<void> {
    return this.open(roomId, {
      type: 'open',
      target: { kind: 'thread', root_event_id: rootEventId },
      hidden_events: false,
      unread: false,
      has_unread: false,
      landing: null,
    });
  }

  startUnread(roomId: string, eventId: string, hiddenEvents = false): Promise<void> {
    return this.open(roomId, {
      type: 'open',
      target: { kind: 'unread', event_id: eventId },
      hidden_events: hiddenEvents,
      unread: false,
      has_unread: false,
      landing: null,
    });
  }

  async resumeLive(): Promise<void> {
    await this.request({ type: 'resume_live' });
  }

  paginateBackward(count: number): Promise<boolean> {
    return this.paginate('backward', count);
  }

  paginateForward(count: number): Promise<boolean> {
    return this.paginate('forward', count);
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    this.close();
    await handle?.dispatch({ type: 'stop' }).catch((error: unknown) => {
      console.debug('[sable timeline] timeline not stopped', error);
    });
  }

  detach(): void {
    this.send({ type: 'release' });
    this.close();
  }

  async initializeUnread(hasUnread: boolean): Promise<void> {
    await this.request({ type: 'initialize_unread', has_unread: hasUnread });
  }

  observeUnread(firstVisible: string | null): void {
    this.send({ type: 'observe_unread', first_visible: firstVisible });
  }

  viewing(focused: boolean, newest: string | null): void {
    this.send({ type: 'viewing', focused, newest });
  }

  read(eventId: string): void {
    this.send({ type: 'read', event_id: eventId });
  }

  roomUnread(hasUnread: boolean, keepBoundary = false): void {
    this.send({ type: 'room_unread', has_unread: hasUnread, keep_boundary: keepBoundary });
  }

  clearUnread(): void {
    this.send({ type: 'clear_unread' });
  }

  private send(action: TimelineAction): void {
    this.handle?.send(action);
  }

  private request<T extends keyof Replies>(
    action: Extract<TimelineAction, { type: T }>
  ): Promise<Replies[T] | undefined> {
    return this.handle?.request(action) ?? Promise.resolve(undefined);
  }

  private async paginate(direction: 'backward' | 'forward', count: number): Promise<boolean> {
    const answer = await this.request({ type: 'paginate', direction, count });
    return answer?.reached_end ?? false;
  }

  private async open(
    roomId: string,
    action: Extract<TimelineAction, { type: 'open' }>
  ): Promise<void> {
    if (this.roomId !== roomId || this.handle === null) {
      this.send({ type: 'release' });
      this.close();
      this.roomId = roomId;
      this.attaching = this.attach(roomId);
    }
    const token = ++this.openToken;
    const generation = this.generation;
    const handle = this.handle;
    try {
      await this.attaching;
      if (token !== this.openToken || generation !== this.generation || handle !== this.handle)
        return;
      await handle?.request(action);
    } catch (error) {
      console.debug('[sable timeline] timeline not opened', error);
    }
  }

  private async attach(roomId: string): Promise<void> {
    const generation = ++this.generation;
    const handle: Handle = new SliceHandle(
      'timeline',
      { room_id: roomId, view: this.view },
      this.connect,
      {
        window: this.windowed ? PARKED : null,
        onChange: () => {
          this.served = handle.view;
          this.followTail();
        },
        onOpen: () => {
          this.configuration = null;
          this.configure();
        },
      }
    );
    this.handle = handle;
    this.served = undefined;
    this.release.push(
      $effect.root(() => {
        $effect(() => {
          this.configure();
        });
      })
    );
    try {
      await handle.open();
    } catch (error) {
      if (generation === this.generation) this.close();
      throw error;
    }
  }

  // Grow before the viewport reaches the held edge, and trim after scrolling settles.
  cover(first: number, settled: boolean): void {
    if (!this.windowed) return;
    const held = this.first;
    if (first < held + 40 && held > 0) this.hold(first);
    else if (settled && held > first + TRIM_AFTER) this.hold(first);
  }

  private hold(first: number): void {
    const start = first - ROWS_ABOVE < NEAR_TOP ? 0 : first - ROWS_ABOVE;
    if (start === this.first || this.handle === null) return;
    this.range({ start, end: FOLLOWING });
  }

  // A parked or emptied window moves to the newest rows once the total is known.
  private followTail(): void {
    const total = this.total;
    if (!this.windowed || total === 0 || this.rows.length > 0 || this.moving) return;
    this.range({ start: Math.max(0, total - TAIL_ROWS), end: FOLLOWING });
  }

  private moving = false;

  private range(window: { start: number; end: number }): void {
    const handle = this.handle;
    if (handle === null) return;
    this.moving = true;
    handle
      .range(window)
      .catch((error: unknown) => {
        console.debug('[sable timeline] window not moved', error);
      })
      .finally(() => {
        if (handle !== this.handle) return;
        this.moving = false;
        this.served = handle.view;
        this.followTail();
      });
  }

  private close(): void {
    this.generation += 1;
    this.openToken += 1;
    this.attaching = null;
    for (const release of this.release.splice(0)) release();
    this.handle?.close();
    this.handle = null;
    this.roomId = null;
    this.served = undefined;
    this.moving = false;
    this.configuration = null;
  }

  private configuration: string | null = null;

  private configure(): void {
    if (!this.ready) return;
    const action: Extract<TimelineAction, { type: 'configure' }> = {
      type: 'configure',
      filters: {
        hide_membership_events: preferences.hideMembershipEvents,
        hide_profile_changes: preferences.hideProfileChanges,
        hide_topic_changes: preferences.hideTopicChanges,
        hide_member_in_read_only: preferences.hideMemberInReadOnly,
        show_tombstone_events: preferences.showTombstoneEvents,
        show_hidden_events: preferences.showHiddenEvents,
        hidden_event_edits: preferences.hiddenEventEdits,
        hidden_event_reactions: preferences.hiddenEventReactions,
        hidden_event_redactions: preferences.hiddenEventRedactions,
        hidden_event_other: preferences.hiddenEventOther,
      },
      reply_style: preferences.replyPreviewStyle,
      read_only: this.shown.readOnly,
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a one-off read of the clock's offset
      utc_offset_minutes: -new Date().getTimezoneOffset(),
      thread_root: this.shown.threadRoot,
    };
    const configuration = JSON.stringify(action);
    if (configuration === this.configuration) return;
    this.configuration = configuration;
    this.send(action);
  }
}

export class ActiveRoomTimeline {
  readonly timeline = new RoomTimeline(runtime, true);
  private owner: symbol | null = null;

  async start(
    owner: symbol,
    roomId: string,
    eventId: string | null,
    hiddenEvents = false,
    unread = false,
    landing: string | null = null,
    hasUnread = false
  ): Promise<void> {
    this.owner = owner;
    await this.timeline.start(roomId, eventId, hiddenEvents, unread, landing, hasUnread);
  }

  async startThread(owner: symbol, roomId: string, rootEventId: string): Promise<void> {
    this.owner = owner;
    await this.timeline.startThread(roomId, rootEventId);
  }

  resumeLive(owner: symbol): Promise<void> {
    if (this.owner !== owner) return Promise.reject(new Error('Timeline owner changed'));
    return this.timeline.resumeLive();
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

  /** The runtime keeps the timeline for a moment, in case the room comes back. */
  stop(owner: symbol): void {
    if (this.owner !== owner) return;
    this.owner = null;
    this.timeline.detach();
  }
}

let active: ActiveRoomTimeline | undefined;

/** Built under its own root, so the first room view to ask does not own what every later one reads. */
export function activeRoomTimeline(): ActiveRoomTimeline {
  if (active === undefined) {
    $effect.root(() => {
      active = new ActiveRoomTimeline();
    });
  }
  return active as ActiveRoomTimeline;
}
