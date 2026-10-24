import { asWireRows, asWireItems } from '#lib/test-support/timeline-wire.js';
import {
  type ResolvedItem,
  type ResolvedRow,
  resolveItem,
  resolveRow,
} from '#lib/rooms/timeline-item.js';
import { untrack } from 'svelte';

import type {
  TimelineDocView,
  TimelineModeView,
  TimelineStatus,
  TimelineUnreadView,
} from '#src/generated/protocol';

import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

const MESSAGE_GAP_MS = 120_000;

function keyOf(item: ResolvedItem): string {
  if (item.event_id) return `event:${item.event_id}`;
  if (item.transaction_id) return `transaction:${item.transaction_id}`;
  return `item:${item.id}`;
}

const HIDDEN_BY_DEFAULT = new Set(['profile_change', 'hidden', 'tombstone']);

interface Unread {
  firstEventId: string | null;
  /** Without an unread boundary, the core's own marker goes once the reader has caught up. */
  hideMarker: boolean;
}

/** One row per item the default filters leave, keyed the way the runtime keys them, grouping nothing but runs of one sender. */
export function rowsOf(
  items: readonly ResolvedItem[],
  unread: Unread = { firstEventId: null, hideMarker: false }
): ResolvedRow[] {
  let shown = items.filter((item) => !HIDDEN_BY_DEFAULT.has(item.visibility));
  if (unread.firstEventId !== null) {
    const rest = shown.filter((item) => item.content.kind !== 'read_marker');
    const index = rest.findIndex((item) => item.event_id === unread.firstEventId);
    const marker = shown.find((item) => item.content.kind === 'read_marker') ?? {
      ...items[0],
      id: 'unread-marker',
      row: 'annotation',
      event_id: null,
      transaction_id: null,
      sender: null,
      sender_name: null,
      timestamp: 0,
      content: { kind: 'read_marker' },
      reactions: [],
      read_by: [],
      read_timestamps: {},
    };
    shown = index < 0 ? rest : [...rest.slice(0, index), marker, ...rest.slice(index)];
  } else if (unread.hideMarker) {
    shown = shown.filter((item) => item.content.kind !== 'read_marker');
  }
  return shown.map((item, index) => {
    const before = shown.at(index - 1);
    const collapsed =
      index > 0 &&
      before !== undefined &&
      item.row === 'message' &&
      before.row === 'message' &&
      item.sender !== null &&
      item.sender === before.sender &&
      Math.abs(item.timestamp - before.timestamp) < MESSAGE_GAP_MS;
    return {
      key: keyOf(item),
      reply_target: item.event_id !== null && item.row === 'message',
      item,
      group: null,
      segments: [],
      collapsed,
      group_start: index > 0 && !collapsed,
      unread_count:
        item.content.kind === 'read_marker'
          ? shown.slice(index + 1).filter((later) => !later.is_own && later.row === 'message')
              .length
          : 0,
      receipts: null,
    };
  });
}

/** A row that folds a run of membership events, as the runtime makes one. */
export function groupRow(members: readonly ResolvedItem[]): ResolvedRow {
  const last = members[members.length - 1];
  return {
    ...rowsOf([last])[0],
    group: members.map((item) => ({ reply_target: false, item })),
    segments: [
      {
        category: 'joined',
        users: members.map((item) => ({
          user_id: item.sender ?? '',
          name: item.sender_name ?? '',
        })),
      },
    ],
  };
}

interface Patch {
  items?: readonly ResolvedItem[];
  rows?: readonly ResolvedRow[];
  aggregations?: readonly ResolvedItem[];
  mode?: TimelineModeView;
  loading?: boolean;
  resumingLive?: boolean;
  hasSnapshot?: boolean;
  error?: string | null;
  backwardPagination?: TimelineStatus['backward_pagination'];
  forwardPagination?: TimelineStatus['forward_pagination'];
  readMarkerEventId?: string | null;
  unread?: Partial<TimelineUnreadView>;
}

function statusMode(mode: TimelineModeView): TimelineStatus['mode'] {
  return mode;
}

function emptyView(unread: TimelineUnreadView): TimelineDocView {
  return {
    total: 0,
    items: [],
    status: {
      mode: { kind: 'live' },
      loading: false,
      resuming_live: false,
      has_snapshot: true,
      forward_pagination: 'idle',
      backward_pagination: 'idle',
      error: null,
      subscription: null,
      can_resume_live: false,
      reaches_latest: true,
      latest_event_id: null,
      item_count: 0,
      unread,
    },
    aggregations: { total: 0, items: [] },
    events: { total: 0, items: [] },
  };
}

/**
 * A timeline that shows what a test gives it, as the runtime would have staged it.
 * Takes the class so a test that mocks its module can build it from the real one.
 */
export function staticTimelineOf(Base: typeof RoomTimeline, noUnread: TimelineUnreadView) {
  return class StaticTimeline extends Base {
    private staged = $state.raw<TimelineDocView>(emptyView(noUnread));
    readonly actions: string[] = [];
    /** What the core would hold, which the rows are made from. */
    private rawItems: readonly ResolvedItem[] = [];
    private explicitRows: ResolvedRow[] | null = null;
    private readMarkerEventId: string | null = null;

    protected override get doc(): TimelineDocView {
      return this.staged;
    }

    /** The state without depending on it, since a test patches from inside effects. */
    private get now(): TimelineDocView {
      return untrack(() => this.staged);
    }

    private get shownRows(): ResolvedRow[] {
      return this.now.items.map(resolveRow);
    }

    private get shownAggregations(): ResolvedItem[] {
      return this.now.aggregations.items.map(resolveItem);
    }

    patch(change: Patch, resolve = true): void {
      const staged = this.now;
      const status = { ...staged.status };
      let rows = this.shownRows;
      let raw = this.rawItems;
      let aggregations = this.shownAggregations;
      if (change.items !== undefined) {
        raw = change.items;
        this.rawItems = raw;
        status.item_count = raw.length;
        status.latest_event_id = [...raw].reverse().find((item) => item.event_id)?.event_id ?? null;
      }
      if (change.rows) this.explicitRows = [...change.rows];
      else if (change.items !== undefined) this.explicitRows = null;
      if (change.aggregations) aggregations = change.aggregations as ResolvedItem[];
      if (change.mode) {
        status.mode = statusMode(change.mode);
        status.can_resume_live = change.mode.kind === 'unread';
        status.reaches_latest = change.mode.kind === 'live';
      }
      if (change.loading !== undefined) status.loading = change.loading;
      if (change.resumingLive !== undefined) status.resuming_live = change.resumingLive;
      if (change.hasSnapshot !== undefined) status.has_snapshot = change.hasSnapshot;
      if (change.error !== undefined) status.error = change.error;
      if (change.backwardPagination) status.backward_pagination = change.backwardPagination;
      if (change.forwardPagination) {
        status.forward_pagination = change.forwardPagination;
        if (status.mode.kind !== 'live') status.reaches_latest = change.forwardPagination === 'end';
      }
      if (change.readMarkerEventId !== undefined) {
        this.readMarkerEventId = change.readMarkerEventId;
      }
      if (change.unread) {
        const unread = change.unread;
        const same = (Object.keys(unread) as (keyof TimelineUnreadView)[]).every(
          (field) => status.unread[field] === unread[field]
        );
        if (same && Object.keys(change).length === 1) return;
        status.unread = { ...status.unread, ...unread };
      }
      if (this.explicitRows) rows = this.explicitRows;
      else if (change.items !== undefined || change.unread !== undefined) {
        rows = rowsOf(raw, {
          firstEventId: status.unread.first_event_id,
          hideMarker: !status.unread.active,
        });
      }
      this.staged = {
        total: rows.length,
        items: asWireRows(rows),
        events: { total: raw.length, items: asWireItems(raw) },
        status,
        aggregations: { total: aggregations.length, items: asWireItems(aggregations) },
      };
      if (resolve && change.unread === undefined) this.resolveUnread();
    }

    /** What the runtime would fetch for the read marker. */
    loadMarker: () => Promise<string | null> = () => Promise.resolve(null);

    private resolveUnread(): void {
      const { unread, mode } = this.now.status;
      if (!unread.active || unread.loading || unread.failed) return;
      const items = this.rawItems;
      const unseen = items.filter(
        (item) => item.event_id !== null && !item.is_own && item.row === 'message'
      );
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup built and dropped in one call
      const ids = new Set(unseen.map((item) => item.event_id));
      let first = unread.first_event_id;
      if (first !== null) {
        if (ids.has(first)) return;
        const index = items.findIndex((item) => item.event_id === first);
        if (index < 0) return;
        first = items.slice(index + 1).find((item) => ids.has(item.event_id))?.event_id ?? first;
      } else {
        const marker = items.findIndex((item) => item.content.kind === 'read_marker');
        const read = items.findIndex((item) => item.event_id === unread.read_event_id);
        const boundary = marker >= 0 ? marker : read;
        const oldestLoaded =
          this.now.status.backward_pagination === 'end' &&
          (mode.kind === 'live' || this.now.status.forward_pagination === 'end');
        if (boundary < 0 && !oldestLoaded) return;
        first = items.slice(boundary + 1).find((item) => ids.has(item.event_id))?.event_id ?? null;
        if (first === null) {
          this.patch({ unread: { active: false, blocking: false } });
          return;
        }
      }
      const from = items.findIndex((item) => item.event_id === first);
      const count = items.slice(from).filter((item) => ids.has(item.event_id)).length;
      if (first !== unread.first_event_id || count !== unread.count) {
        this.patch({ unread: { first_event_id: first, count } }, false);
      }
    }

    override async initializeUnread(hasUnread: boolean): Promise<void> {
      this.actions.push('initialize_unread');
      if (this.now.status.unread.initialized) return;
      const active = hasUnread || this.rawItems.some((item) => item.content.kind === 'read_marker');
      this.patch(
        {
          unread: {
            initialized: true,
            active,
            blocking: active,
            read_event_id: this.readMarkerEventId,
          },
        },
        false
      );
      this.resolveUnread();
      if (!active || this.now.status.unread.first_event_id !== null) return;
      this.patch({ unread: { loading: true, blocking: true } }, false);
      const marker = await this.loadMarker();
      this.patch({ unread: { loading: false, read_event_id: marker } }, false);
      this.resolveUnread();
    }

    override observeUnread(firstVisible: string | null): void {
      this.actions.push('observe_unread');
      const unread = this.now.status.unread;
      if (unread.active && firstVisible !== null && firstVisible === unread.first_event_id) {
        this.patch({ unread: { blocking: false } });
      }
    }

    override viewing(focused: boolean, newest: string | null): void {
      this.actions.push('viewing');
      const { unread, latest_event_id: latest } = this.now.status;
      if (unread.active && focused && newest !== null && newest === latest) {
        this.patch({ unread: { blocking: false } });
      }
    }

    override read(eventId: string): void {
      this.actions.push('read');
      if (eventId === this.now.status.latest_event_id) {
        this.patch({
          unread: { active: false, blocking: false },
        });
      }
    }

    override roomUnread(): void {
      this.actions.push('room_unread');
    }

    override clearUnread(): void {
      this.actions.push('clear_unread');
      this.patch({
        unread: { active: false, first_event_id: null, blocking: false },
      });
    }

    override show(): void {
      this.actions.push('show');
    }
  };
}

export type StaticTimeline = InstanceType<ReturnType<typeof staticTimelineOf>>;
