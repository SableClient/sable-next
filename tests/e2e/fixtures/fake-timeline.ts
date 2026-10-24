import type {
  CoreEvent,
  TimelineDocView,
  TimelineItemView,
  TimelineRowView,
  TimelineStatus,
  TimelineUnreadView,
} from '#src/generated/protocol';
import type { ResolvedItem, ResolvedRow } from '#lib/rooms/timeline-item.js';

type VectorDiff<T> =
  | { op: 'append'; values: T[] }
  | { op: 'clear' }
  | { op: 'push_front'; value: T }
  | { op: 'push_back'; value: T }
  | { op: 'pop_front' }
  | { op: 'pop_back' }
  | { op: 'insert'; index: number; value: T }
  | { op: 'set'; index: number; value: T }
  | { op: 'remove'; index: number }
  | { op: 'truncate'; length: number }
  | { op: 'reset'; values: T[] };

/** What the page script below finds on `window`, put there by the fake core. */
export interface FakeTimelineBridge {
  call(method: string, params: unknown): Promise<unknown>;
  /** Tells the page the document of one timeline changed. */
  publish(key: string, doc: TimelineDocView): void;
}

declare global {
  interface Window {
    __e2eTimelineBridge: FakeTimelineBridge;
    __e2eTimeline: {
      doc(key: string): TimelineDocView;
      act(key: string, action: unknown): Promise<unknown>;
      onCoreEvent(event: CoreEvent): void;
    };
  }
}

/**
 * Serves the `timeline` slice to the fake runtime in the page the way the real one does,
 * from the items the fake core hands out. It runs in the page, so it uses nothing outside itself.
 */
export function installFakeTimelineSlice(): void {
  type Item = ResolvedItem;
  type Row = Omit<ResolvedRow, 'receipts'> & { later_receipts?: ResolvedRow['receipts'] };
  type Mode = TimelineStatus['mode'];
  type Pagination = TimelineStatus['backward_pagination'];
  type Action = {
    type: string;
    [field: string]: unknown;
  };
  interface Filters {
    hide_membership_events: boolean;
    hide_profile_changes: boolean;
    hide_topic_changes: boolean;
    hide_member_in_read_only: boolean;
    show_tombstone_events: boolean;
    show_hidden_events: boolean;
  }
  interface Subscribed {
    subscription: number;
    items: Item[];
    aggregations: Item[];
  }

  const UNREAD_KINDS = new Set([
    'message',
    'image',
    'video',
    'audio',
    'file',
    'sticker',
    'gallery',
    'location',
    'live_location',
    'poll',
    'unable_to_decrypt',
  ]);
  const MEMBERSHIP_CATEGORIES: Record<string, string> = {
    joined: 'joined',
    invitation_accepted: 'joined',
    left: 'left',
    invited: 'invited',
    invitation_rejected: 'invitation_rejected',
    knocked: 'knocked',
    knock_retracted: 'knock_retracted',
    other: 'other',
  };

  const bridge = (): FakeTimelineBridge => window.__e2eTimelineBridge;
  const unreadMessage = (item: Item): boolean =>
    item.event_id !== null && !item.is_own && UNREAD_KINDS.has(item.content.kind);
  const eventIdIs = (item: Item, id: string | null): boolean => id !== null && item.event_id === id;

  function visible(item: Item, filters: Filters, readOnly: boolean): boolean {
    const memberHidden = readOnly && filters.hide_member_in_read_only;
    switch (item.visibility) {
      case 'membership':
        return !filters.hide_membership_events && !memberHidden;
      case 'membership_other':
        return !filters.hide_membership_events && !memberHidden && filters.show_hidden_events;
      case 'profile_change':
        return !filters.hide_profile_changes && !memberHidden;
      case 'tombstone':
        return filters.show_tombstone_events;
      case 'hidden':
        return filters.show_hidden_events;
      case 'always':
        return !(
          filters.hide_topic_changes &&
          item.content.kind === 'state_event' &&
          item.content.change?.kind === 'room_topic'
        );
    }
  }

  function filtered(items: readonly Item[], filters: Filters, readOnly: boolean): Item[] {
    const shown = new Set<string>();
    const kept: Item[] = [];
    let lastEvent = -1;
    for (const item of items) {
      if (item.event_id) {
        if (shown.has(item.event_id)) continue;
        shown.add(item.event_id);
      }
      if (visible(item, filters, readOnly)) {
        kept.push(item);
        if (item.event_id) lastEvent = kept.length - 1;
      } else if (item.read_by.length > 0 && lastEvent >= 0) {
        const holder = kept[lastEvent];
        kept[lastEvent] = {
          ...holder,
          read_by: [...holder.read_by, ...item.read_by],
          read_timestamps: { ...holder.read_timestamps, ...item.read_timestamps },
        };
      }
    }
    const out: Item[] = [];
    let hasEventBelow = false;
    let hasUnreadBelow = false;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const item = kept[index];
      if (item.content.kind === 'date_divider') {
        if (!hasEventBelow) continue;
        hasEventBelow = false;
      } else if (item.content.kind === 'read_marker') {
        if (!hasUnreadBelow) continue;
      } else if (item.row !== 'annotation') {
        hasEventBelow = true;
        if (!item.is_own && UNREAD_KINDS.has(item.content.kind)) hasUnreadBelow = true;
      }
      out.push(item);
    }
    return out.reverse();
  }

  function withMarkerBefore(items: Item[], eventId: string): Item[] {
    const rest = items.filter((item) => item.content.kind !== 'read_marker');
    const index = rest.findIndex((item) => item.event_id === eventId);
    if (index < 0) return rest;
    const marker = items.find((item) => item.content.kind === 'read_marker') ?? {
      ...rest[0],
      id: 'unread-marker',
      row: 'annotation',
      forwardable: false,
      redactable: false,
      visibility: 'always',
      event_id: null,
      transaction_id: null,
      sender: null,
      sender_name: null,
      timestamp: 0,
      content: { kind: 'read_marker' },
      in_reply_to: null,
      thread_root: null,
      thread_summary: null,
      reactions: [],
      read_by: [],
      read_timestamps: {},
    };
    return [...rest.slice(0, index), marker, ...rest.slice(index)];
  }

  function category(item: Item): string | null {
    if (item.event_id === null || item.reactions.length > 0) return null;
    const content = item.content;
    if (content.kind === 'membership') return MEMBERSHIP_CATEGORIES[content.change] ?? null;
    if (content.kind === 'profile_change') {
      if (content.display_name !== null) return 'name';
      return content.avatar !== null ? 'avatar' : null;
    }
    return null;
  }

  function personaKey(item: Item): string {
    const profile = item.per_message_profile;
    if (!profile) return '';
    return (profile.id ?? profile.display_name ?? '') + (profile.avatar_url ?? '');
  }

  function collapsed(items: Item[], index: number, connectedReplies: boolean): boolean {
    if (index === 0) return false;
    const current = items[index];
    const previous = items[index - 1];
    if (current.row === 'event' && previous.row === 'event') return true;
    if (connectedReplies && current.in_reply_to) return false;
    return (
      current.row === 'message' &&
      previous.row === 'message' &&
      current.sender !== null &&
      current.sender === previous.sender &&
      personaKey(current) === personaKey(previous) &&
      Math.abs(current.timestamp - previous.timestamp) < 120_000
    );
  }

  function laterReceiptsFor(items: Item[]): (ResolvedRow['receipts'] | undefined)[] {
    const out: (ResolvedRow['receipts'] | undefined)[] = items.map(() => undefined);
    const seen = new Set<string>();
    let readers: string[] = [];
    let timestamps: Record<string, number> = {};
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const fresh = item.read_by.filter((user) => !seen.has(user));
      if (fresh.length === 0) continue;
      if (readers.length > 0) out[index] = { readers: [...readers], timestamps };
      timestamps = { ...timestamps };
      for (const user of fresh) {
        seen.add(user);
        if (Object.hasOwn(item.read_timestamps, user))
          timestamps[user] = item.read_timestamps[user];
      }
      readers = [...fresh, ...readers];
    }
    return out;
  }

  class FakeTimeline {
    items: Item[] = [];
    aggregations: Item[] = [];
    mode: Mode = { kind: 'live' };
    loading = false;
    resuming = false;
    hasSnapshot = false;
    error: string | null = null;
    forward: Pagination = 'idle';
    backward: Pagination = 'idle';
    readMarker: string | null = null;
    subscription: number | null = null;
    config = {
      filters: {
        hide_membership_events: false,
        hide_profile_changes: true,
        hide_topic_changes: false,
        hide_member_in_read_only: true,
        show_tombstone_events: false,
        show_hidden_events: false,
      } as Filters,
      replyStyle: 'connected',
      readOnly: false,
      threadRoot: null as string | null,
    };
    unread = {
      initialized: false,
      loading: false,
      active: false,
      reached: false,
      background: false,
      firstEventId: null as string | null,
      readEventId: null as string | null,
      failed: false,
      lastEventId: undefined as string | null | undefined,
    };
    private session = 0;
    private startRequest = 0;
    private target: { mode: Mode; hidden: boolean } | null = null;
    private starting: Promise<void> | null = null;
    private pending: Extract<CoreEvent, { type: 'timeline_diff' }>[] = [];
    private phase: 'stopped' | 'pending' | 'active' = 'stopped';
    private unsubscribing: Promise<unknown> = Promise.resolve();
    private hasUnread = false;
    private viewing: { focused: boolean; newest: string | null } | null = null;
    private resume: Promise<void> | null = null;

    constructor(
      private readonly key: string,
      private readonly roomId: string
    ) {}

    publish(): void {
      bridge().publish(this.key, this.doc());
    }

    doc(): TimelineDocView {
      const rows = this.rows();
      const eventItems = this.eventItems();
      const status: TimelineStatus = {
        mode: this.mode,
        loading: this.loading,
        resuming_live: this.resuming,
        has_snapshot: this.hasSnapshot,
        forward_pagination: this.forward,
        backward_pagination: this.backward,
        error: this.error,
        subscription: this.subscription,
        can_resume_live: this.mode.kind === 'unread' || this.resuming,
        reaches_latest: !this.resuming && (this.mode.kind === 'live' || this.forward === 'end'),
        latest_event_id: [...this.items].reverse().find((item) => item.event_id)?.event_id ?? null,
        item_count: this.items.length,
        unread: this.unreadView(eventItems),
      };
      return {
        total: rows.length,
        items: rows as unknown as TimelineRowView[],
        status,
        aggregations: {
          total: this.aggregations.length,
          items: this.aggregations as unknown as TimelineItemView[],
        },
        events: {
          total: this.items.length,
          items: this.items as unknown as TimelineItemView[],
        },
      };
    }

    private eventItems(): Item[] {
      return filtered(this.items, this.config.filters, this.config.readOnly);
    }

    private rows(): Row[] {
      this.attend();
      this.resolveUnread();
      let all = this.eventItems();
      if (this.unread.firstEventId !== null) all = withMarkerBefore(all, this.unread.firstEventId);
      else if (!this.unread.active) all = all.filter((item) => item.content.kind !== 'read_marker');
      const later = laterReceiptsFor(all);
      const keys = new Map<string, number>();
      const keyOf = (item: Item, index: number): string => {
        let base = item.transaction_id
          ? `item:${item.id}`
          : item.event_id
            ? `event:${item.event_id}`
            : `item:${item.id}`;
        if (
          !item.event_id &&
          !item.transaction_id &&
          (item.content.kind === 'date_divider' || item.content.kind === 'timeline_start')
        ) {
          const next = all.slice(index + 1).find((later) => later.event_id);
          if (next) base = `boundary:${item.id}:event:${next.event_id}`;
        }
        const seen = keys.get(base) ?? 0;
        keys.set(base, seen + 1);
        return seen === 0 ? base : `${base}#${String(seen)}`;
      };
      const allKeys = all.map((item, index) => keyOf(item, index));
      const units: { item: Item; source: number; group: Item[] | null }[] = [];
      for (let start = 0; start < all.length;) {
        let end = start;
        while (end < all.length && category(all[end]) !== null) end += 1;
        if (end - start >= 2) {
          units.push({ item: all[end - 1], source: end - 1, group: all.slice(start, end) });
          start = end;
        } else {
          units.push({ item: all[start], source: start, group: null });
          start += 1;
        }
      }
      const unitItems = units.map((unit) => unit.item);
      const root = this.config.threadRoot;
      return units.map((unit, index) => {
        const holdsRoot =
          root !== null &&
          (eventIdIs(unit.item, root) || (index > 0 && eventIdIs(unitItems[index - 1], root)));
        const isCollapsed =
          !holdsRoot && collapsed(unitItems, index, this.config.replyStyle === 'connected');
        return {
          key: allKeys[unit.source],
          reply_target: unit.item.event_id !== null && unit.item.row === 'message',
          item: unit.item,
          group: unit.group
            ? unit.group.map((member) => ({
                reply_target: member.event_id !== null && member.row === 'message',
                item: member,
              }))
            : null,
          segments: [],
          collapsed: isCollapsed,
          group_start: index > 0 && !isCollapsed,
          unread_count:
            unit.item.content.kind === 'read_marker'
              ? all
                  .slice(unit.source + 1)
                  .filter((later) => !later.is_own && UNREAD_KINDS.has(later.content.kind)).length
              : 0,
          later_receipts: later[unit.source],
        };
      });
    }

    private unreadView(eventItems: Item[]): TimelineUnreadView {
      const first = this.unread.firstEventId;
      const index = first === null ? -1 : eventItems.findIndex((item) => item.event_id === first);
      const count =
        index < 0
          ? 0
          : eventItems
              .slice(index)
              .filter((item) => !item.is_own && UNREAD_KINDS.has(item.content.kind)).length;
      return {
        initialized: this.unread.initialized,
        loading: this.unread.loading,
        active: this.unread.active,
        first_event_id: first,
        read_event_id: this.unread.readEventId,
        failed: this.unread.failed,
        count,
        blocking:
          !this.unread.initialized ||
          this.unread.loading ||
          (this.unread.active && !this.unread.reached),
      };
    }

    private oldestLoaded(): boolean {
      return this.backward === 'end' && (this.mode.kind === 'live' || this.forward === 'end');
    }

    private resolveUnread(): void {
      const u = this.unread;
      if (!u.active || u.loading || u.failed) return;
      const items = this.items;
      const unseen = new Set(
        this.eventItems()
          .filter(unreadMessage)
          .map((item) => item.event_id)
      );
      if (u.firstEventId !== null) {
        if (unseen.has(u.firstEventId)) return;
        const index = items.findIndex((item) => item.event_id === u.firstEventId);
        if (index < 0) return;
        const next = items.slice(index + 1).find((item) => unseen.has(item.event_id));
        if (next) u.firstEventId = next.event_id;
        return;
      }
      const marker = items.findIndex((item) => item.content.kind === 'read_marker');
      const read =
        u.readEventId === null ? -1 : items.findIndex((item) => item.event_id === u.readEventId);
      const boundary = marker >= 0 ? marker : read;
      if (boundary < 0 && !this.oldestLoaded()) return;
      const first = items.slice(boundary + 1).find((item) => unseen.has(item.event_id));
      if (first) u.firstEventId = first.event_id;
      else if (boundary >= 0 || this.oldestLoaded()) this.dismiss();
    }

    private dismiss(): void {
      this.unread.active = false;
      this.unread.reached = true;
      this.unread.background = false;
    }

    private async initializeUnread(hasUnread: boolean): Promise<void> {
      const u = this.unread;
      if (u.loading) return this.unreadLoad;
      if (u.initialized && !u.failed) return;
      if (!u.initialized) {
        u.active = hasUnread || this.items.some((item) => item.content.kind === 'read_marker');
        u.readEventId ??= this.readMarker;
      }
      u.initialized = true;
      u.failed = false;
      this.resolveUnread();
      if (!u.active || u.firstEventId !== null) return;
      u.loading = true;
      this.unreadLoad = bridge()
        .call('timeline.read_marker', { room_id: this.roomId })
        .then((eventId) => {
          u.readEventId = eventId as string | null;
        })
        .catch(() => {
          u.failed = true;
        })
        .finally(() => {
          u.loading = false;
          this.unreadLoad = Promise.resolve();
          this.publish();
        });
      this.publish();
      await this.unreadLoad;
    }
    private unreadLoad: Promise<void> = Promise.resolve();

    private async stopCurrent(keepContent: boolean): Promise<void> {
      this.session += 1;
      this.phase = 'stopped';
      this.starting = null;
      this.resuming = false;
      this.mode = { kind: 'live' };
      this.loading = false;
      this.hasSnapshot = keepContent && this.hasSnapshot;
      this.readMarker = null;
      this.forward = 'idle';
      this.backward = 'idle';
      this.error = null;
      if (!keepContent) {
        this.items = [];
        this.aggregations = [];
      }
      this.pending = [];
      this.target = null;
      const subscription = this.subscription;
      this.subscription = null;
      this.publish();
      if (subscription !== null) {
        this.unsubscribing = this.unsubscribing
          .then(() => bridge().call('timeline.unsubscribe', { subscription }))
          .catch(() => undefined);
      }
      await this.unsubscribing;
    }

    reset(): void {
      this.unread = {
        initialized: false,
        loading: false,
        active: false,
        reached: false,
        background: false,
        firstEventId: null,
        readEventId: null,
        failed: false,
        lastEventId: undefined,
      };
    }

    private sameMode(left: Mode, right: Mode): boolean {
      if (left.kind !== right.kind) return false;
      if (left.kind === 'thread' && right.kind === 'thread') {
        return left.root_event_id === right.root_event_id;
      }
      if ('event_id' in left && 'event_id' in right) return left.event_id === right.event_id;
      return true;
    }

    private focus(mode: Mode): unknown {
      if (mode.kind === 'live') return { kind: 'live' };
      if (mode.kind === 'thread') return { kind: 'thread', root_event_id: mode.root_event_id };
      return { kind: 'event', event_id: mode.event_id };
    }

    private subscribe(mode: Mode, hidden: boolean): Promise<Subscribed> {
      return bridge().call('timeline.subscribe', {
        room_id: this.roomId,
        focus: this.focus(mode),
        hidden_events: hidden,
      }) as Promise<Subscribed>;
    }

    async open(
      mode: Mode,
      hidden: boolean,
      unread: boolean,
      landing: string | null,
      force = false
    ): Promise<void> {
      if (
        !force &&
        this.target &&
        (this.sameMode(this.target.mode, mode) || this.sameMode(this.mode, mode)) &&
        this.target.hidden === hidden
      ) {
        if (this.subscription !== null) return;
        if (this.starting) return this.starting.catch(() => undefined);
      }
      const request = ++this.startRequest;
      if (this.target !== null || this.resuming) await this.stopCurrent(force);
      await this.unsubscribing;
      if (request !== this.startRequest) return;
      this.target = { mode, hidden };
      this.mode = mode;
      if (mode.kind === 'unread') this.readMarker = mode.event_id;
      this.forward = mode.kind === 'thread' ? 'end' : 'idle';
      this.loading = true;
      this.error = null;
      this.phase = 'pending';
      this.publish();
      const session = this.session;
      const starting = this.start(mode, hidden, unread, landing, session);
      this.starting = starting;
      try {
        await starting;
      } catch {
        if (session === this.session) {
          this.error = 'load_failed';
          this.phase = 'stopped';
          if (force) {
            this.items = [];
            this.aggregations = [];
            this.hasSnapshot = false;
          }
        }
      } finally {
        if (this.starting === starting) this.starting = null;
        if (session === this.session) this.loading = false;
        this.publish();
      }
    }

    private async start(
      mode: Mode,
      hidden: boolean,
      unread: boolean,
      landing: string | null,
      session: number
    ): Promise<void> {
      const context = async (eventId: string): Promise<Subscribed> => {
        try {
          return await this.subscribe({ kind: 'unread', event_id: eventId }, hidden);
        } catch (error) {
          if (session !== this.session) throw error;
          this.pending = [];
          this.mode = { kind: 'live' };
          return this.subscribe({ kind: 'live' }, hidden);
        }
      };
      let response =
        mode.kind === 'unread' ? await context(mode.event_id) : await this.subscribe(mode, hidden);
      const loaded = (eventId: string): boolean =>
        response.items.some((item) => item.event_id === eventId);
      let jump: string | null = null;
      if (this.mode.kind === 'live' && landing !== null) {
        jump = loaded(landing) ? null : landing;
      } else if (
        unread &&
        this.mode.kind === 'live' &&
        session === this.session &&
        !response.items.some((item) => item.content.kind === 'read_marker')
      ) {
        const marker = await bridge()
          .call('timeline.read_marker', { room_id: this.roomId })
          .then((value) => value as string | null)
          .catch(() => null);
        if (session === this.session) this.readMarker = marker;
        jump = marker !== null && !loaded(marker) ? marker : null;
      }
      if (session === this.session && jump !== null) {
        await bridge().call('timeline.unsubscribe', { subscription: response.subscription });
        if (session !== this.session) return;
        this.pending = [];
        this.mode = { kind: 'unread', event_id: jump };
        this.readMarker = jump;
        response = await context(jump);
      }
      if (session !== this.session) {
        void bridge().call('timeline.unsubscribe', { subscription: response.subscription });
        return;
      }
      this.subscription = response.subscription;
      let items = response.items;
      for (const event of this.pending) {
        if (event.subscription === response.subscription)
          items = this.applyDiffs(items, event.diffs as unknown as VectorDiff<Item>[]);
      }
      this.pending = [];
      this.items = items;
      this.aggregations = response.aggregations;
      this.hasSnapshot = true;
      this.phase = 'active';
      if (this.mode.kind === 'live' || this.mode.kind === 'thread') this.reset();
      await this.initializeUnread(this.hasUnread);
    }

    private applyDiffs(list: Item[], diffs: VectorDiff<Item>[]): Item[] {
      const items = list.slice();
      for (const diff of diffs) {
        switch (diff.op) {
          case 'append':
            items.push(...diff.values);
            break;
          case 'clear':
            items.length = 0;
            break;
          case 'push_front':
            items.unshift(diff.value);
            break;
          case 'push_back':
            items.push(diff.value);
            break;
          case 'pop_front':
            items.shift();
            break;
          case 'pop_back':
            items.pop();
            break;
          case 'insert':
            items.splice(diff.index, 0, diff.value);
            break;
          case 'set':
            items[diff.index] = diff.value;
            break;
          case 'remove':
            items.splice(diff.index, 1);
            break;
          case 'truncate':
            items.length = Math.min(items.length, diff.length);
            break;
          case 'reset':
            items.splice(0, items.length, ...diff.values);
            break;
        }
      }
      return items;
    }

    onCoreEvent(event: CoreEvent): void {
      if (
        event.type !== 'timeline_diff' &&
        event.type !== 'timeline_pagination' &&
        event.type !== 'timeline_aggregations'
      ) {
        return;
      }
      if (event.type === 'timeline_diff' && this.phase === 'pending') {
        this.pending.push(event);
        return;
      }
      if (this.phase !== 'active' || event.subscription !== this.subscription) return;
      if (event.type === 'timeline_diff') {
        const before = this.items;
        const diffs = event.diffs as unknown as VectorDiff<Item>[];
        this.items = this.applyDiffs(before, diffs);
        if (diffs.some((diff) => diff.op === 'clear' || diff.op === 'reset')) {
          const oldest = this.items.find((item) => item.event_id !== null)?.timestamp ?? Infinity;
          this.aggregations = this.aggregations.filter((item) => item.timestamp >= oldest);
        }
        if (before.length > 0 && this.items.length === 0) {
          this.backward = 'idle';
          if (this.forward === 'loading') this.forward = 'idle';
        }
      } else if (event.type === 'timeline_aggregations') {
        const next = [...this.aggregations];
        for (const item of event.items as unknown as Item[]) {
          const index = next.findIndex((entry) => entry.id === item.id);
          if (index === -1) next.push(item);
          else next[index] = item;
        }
        this.aggregations = next;
      } else if (this.mode.kind === 'live') {
        this.backward = event.loading ? 'loading' : event.reached_start ? 'end' : 'idle';
      }
      this.publish();
    }

    async act(action: Action): Promise<unknown> {
      switch (action.type) {
        case 'configure': {
          this.config = {
            filters: action.filters as Filters,
            replyStyle: action.reply_style as string,
            readOnly: action.read_only as boolean,
            threadRoot: action.thread_root as string | null,
          };
          this.publish();
          return null;
        }
        case 'open': {
          const target = action.target as {
            kind: string;
            event_id?: string;
            root_event_id?: string;
          };
          const mode = (
            target.kind === 'thread'
              ? { kind: 'thread', root_event_id: target.root_event_id }
              : target.kind === 'live'
                ? { kind: 'live' }
                : { kind: target.kind, event_id: target.event_id }
          ) as Mode;
          this.hasUnread = action.has_unread as boolean;
          await this.open(
            mode,
            action.hidden_events as boolean,
            action.unread as boolean,
            action.landing as string | null
          );
          return null;
        }
        case 'resume_live': {
          if (this.mode.kind !== 'unread' && !this.resuming) return null;
          if (this.resume) return this.resume;
          const hidden = this.target?.hidden ?? false;
          this.resuming = true;
          this.publish();
          const task = this.open({ kind: 'live' }, hidden, false, null, true).then(() => {
            if (this.error !== null) throw new Error('Unable to load live messages');
          });
          this.resume = task.finally(() => {
            this.resume = null;
            this.resuming = false;
            this.publish();
          });
          return this.resume;
        }
        case 'stop':
          this.viewing = null;
          this.startRequest += 1;
          await this.stopCurrent(false);
          this.reset();
          this.hasUnread = false;
          return null;
        case 'release':
          this.viewing = null;
          this.reset();
          this.hasUnread = false;
          this.publish();
          return null;
        case 'paginate':
          return this.paginate(action.direction as 'backward' | 'forward', action.count as number);
        case 'initialize_unread':
          await this.initializeUnread(action.has_unread as boolean);
          this.publish();
          return null;
        case 'observe_unread':
          if (
            this.unread.active &&
            action.first_visible !== null &&
            action.first_visible === this.unread.firstEventId
          ) {
            this.unread.reached = true;
            this.unread.background = false;
          }
          this.publish();
          return null;
        case 'viewing':
          this.viewing = {
            focused: action.focused as boolean,
            newest: action.newest as string | null,
          };
          this.publish();
          return null;
        case 'read':
          if (action.event_id === this.latestEventId()) this.dismiss();
          this.publish();
          return null;
        case 'room_unread': {
          const had = this.hasUnread;
          this.hasUnread = action.has_unread as boolean;
          if (had && !this.hasUnread && !action.keep_boundary && this.unread.initialized)
            this.dismiss();
          this.publish();
          return null;
        }
        case 'clear_unread':
          this.dismiss();
          this.unread.firstEventId = null;
          this.publish();
          return null;
        default:
          return null;
      }
    }

    private latestEventId(): string | null {
      return [...this.items].reverse().find((item) => item.event_id)?.event_id ?? null;
    }

    private attend(): void {
      const viewing = this.viewing;
      if (viewing === null || this.mode.kind !== 'live' || !this.hasSnapshot) return;
      this.trackBackground(viewing.focused);
      const latest = this.latestEventId();
      if (
        viewing.focused &&
        !this.unread.background &&
        latest !== null &&
        viewing.newest === latest &&
        this.unread.active
      ) {
        this.unread.reached = true;
      }
    }

    private trackBackground(focused: boolean): void {
      if (this.mode.kind !== 'live' || !this.hasSnapshot) return;
      const items = this.eventItems();
      const previous = this.unread.lastEventId;
      const latest = [...items].reverse().find((item) => item.event_id)?.event_id ?? null;
      this.unread.lastEventId = latest;
      if (focused || previous === undefined || previous === latest) return;
      const index = previous === null ? -1 : items.findIndex((item) => item.event_id === previous);
      if (previous !== null && index < 0) return;
      const first = items.slice(index + 1).find(unreadMessage);
      if (!first) return;
      if (!this.unread.active) {
        this.unread.readEventId = previous;
        this.unread.firstEventId = first.event_id;
      }
      this.unread.active = true;
      this.unread.reached = false;
      this.unread.background = true;
    }

    private async paginate(
      direction: 'backward' | 'forward',
      count: number
    ): Promise<{ reached_end: boolean }> {
      const gated =
        direction === 'backward'
          ? this.backward !== 'idle'
          : this.mode.kind === 'live' || this.mode.kind === 'thread' || this.forward !== 'idle';
      const subscription = this.subscription;
      if (subscription === null || gated) {
        return {
          reached_end: direction === 'backward' ? this.backward === 'end' : true,
        };
      }
      const session = this.session;
      const field = direction === 'backward' ? 'backward' : 'forward';
      this[field] = 'loading';
      this.publish();
      try {
        const answer = (await bridge().call('timeline.paginate', {
          subscription,
          direction,
          count,
        })) as { reached_end: boolean };
        if (session === this.session && subscription === this.subscription) {
          this.error = null;
          this[field] = answer.reached_end ? 'end' : 'idle';
        }
        return { reached_end: answer.reached_end };
      } catch (error) {
        if (session === this.session && subscription === this.subscription) {
          this.error = 'load_failed';
          this[field] = 'idle';
        }
        throw error;
      } finally {
        this.publish();
      }
    }
  }

  const timelines = new Map<string, FakeTimeline>();
  const named = (key: string): FakeTimeline => {
    let timeline = timelines.get(key);
    if (!timeline) {
      timeline = new FakeTimeline(key, (JSON.parse(key) as { room_id: string }).room_id);
      timelines.set(key, timeline);
    }
    return timeline;
  };

  window.__e2eTimeline = {
    doc: (key) => named(key).doc(),
    act: (key, action) => named(key).act(action as Action),
    onCoreEvent: (event) => {
      for (const timeline of timelines.values()) timeline.onCoreEvent(event);
    },
  };
}
