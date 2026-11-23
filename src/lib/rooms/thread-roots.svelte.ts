import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { TimelineItemView } from '#src/generated/protocol';
import { loadThreadReplies, threadReplyRevision } from './thread-replies.js';

export const THREAD_ACTIVITY_WINDOW = 7 * 24 * 60 * 60 * 1000;
const HEADER_REFRESH_INTERVAL = 5000;
const MAX_COUNTED_THREADS = 12;
const COUNT_CONCURRENCY = 4;

export function threadActivity(root: TimelineItemView, latest?: TimelineItemView): number {
  return root.thread_summary?.latest_timestamp ?? latest?.timestamp ?? root.timestamp;
}

export type ThreadUnread = { fresh: boolean; replies: number };
type UnreadDiagnostics = Awaited<ReturnType<CoreClient['rpc']['timeline']['unreadDiagnostics']>>;
type ThreadReceipt = UnreadDiagnostics['threads'][number];
type LocalRead = { eventId: string; timestamp: number };
type CountedUnread = { key: string; count: number };

function countKey(latestId: string, receiptId: string | null | undefined): string {
  return `${latestId}:${receiptId ?? ''}`;
}

function activityCutoff(startedAt: number, readState: UnreadDiagnostics): number {
  return Math.max(startedAt - THREAD_ACTIVITY_WINDOW, readState.unthreaded_receipt_timestamp ?? 0);
}

function unreadForRoot(
  root: TimelineItemView,
  latest: TimelineItemView | undefined,
  receipt: ThreadReceipt | undefined,
  read: LocalRead | undefined,
  counted: CountedUnread | undefined,
  context: { userId: string | undefined; cutoff: number }
): ThreadUnread | null {
  const latestId = root.thread_summary?.latest_event_id;
  const timestamp = threadActivity(root, latest);
  const sender = root.thread_summary?.latest_sender ?? latest?.sender;
  if (timestamp <= context.cutoff) return null;
  if (latestId && (latestId === receipt?.receipt_event_id || latestId === read?.eventId)) {
    return null;
  }
  if (read && timestamp <= read.timestamp) return null;
  if (sender != null && sender === context.userId) return null;
  if (counted?.count === 0) return null;

  if (receipt?.receipt_event_id) {
    if (receipt.receipt_timestamp != null && timestamp <= receipt.receipt_timestamp) {
      return null;
    }
    if (receipt.unread === 0 && latestId == null) return null;
  } else if (!latestId && root.is_own) {
    return null;
  }

  const replies =
    receipt && receipt.unread > 0
      ? receipt.unread
      : (counted?.count ?? (root.thread_summary?.num_replies === 1 && latestId ? 1 : 0));
  return { fresh: !receipt?.receipt_event_id, replies };
}

export class ThreadRoots {
  items = $state.raw<TimelineItemView[]>([]);
  latest = $state.raw<TimelineItemView[]>([]);
  private readState = $state.raw<UnreadDiagnostics | null>(null);
  private readonly locallyRead = new SvelteMap<string, LocalRead>();
  private readonly countedUnread = new SvelteMap<string, CountedUnread>();
  private previewing = false;
  private startedAt = 0;
  private lastLoad = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived index rebuilt from latest items
  readonly latestById = $derived(new Map(this.latest.map((reply) => [reply.event_id, reply])));
  readonly byActivity = $derived.by(() => {
    const latest = this.latestById;
    return this.items
      .slice()
      .sort(
        (a, b) =>
          threadActivity(b, latest.get(b.thread_summary?.latest_event_id ?? null)) -
          threadActivity(a, latest.get(a.thread_summary?.latest_event_id ?? null))
      );
  });
  readonly activity = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived index rebuilt from reactive inputs
    const activity = new Map<string, ThreadUnread>();
    const readState = this.readState;
    if (readState === null) return activity;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived index rebuilt from reactive inputs
    const receipts = new Map(readState.threads.map((entry) => [entry.root_event_id, entry]));
    const context = {
      userId: this.core.session?.user_id,
      cutoff: activityCutoff(this.startedAt, readState),
    };
    for (const root of this.items) {
      const rootId = root.event_id ?? root.id;
      const receipt = receipts.get(rootId);
      const latestId = root.thread_summary?.latest_event_id;
      const latest = this.latestById.get(latestId ?? null);
      const key = latestId ? countKey(latestId, receipt?.receipt_event_id) : null;
      const candidate = this.countedUnread.get(rootId);
      const counted = key !== null && candidate?.key === key ? candidate : undefined;
      const entry = unreadForRoot(
        root,
        latest,
        receipt,
        this.locallyRead.get(rootId),
        counted,
        context
      );
      if (entry) activity.set(rootId, entry);
    }
    return activity;
  });
  readonly unread: ReadonlyMap<string, boolean> = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived map rebuilt from reactive read state
    const unread = new Map<string, boolean>();
    if (this.readState === null) return unread;
    for (const thread of this.readState.threads) {
      if (thread.receipt_event_id !== null || thread.unread > 0) {
        unread.set(thread.root_event_id, thread.unread > 0);
      }
    }
    return unread;
  });
  loading = $state(false);
  error = $state(false);
  nextBatch = $state<string | null>(null);
  private roomId = $state<string | null>(null);
  private generation = 0;
  private pages = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private fetching = false;
  private pending = false;

  constructor(
    private readonly core: CoreClient,
    private readonly options: { lazyPreviews?: boolean } = {}
  ) {}

  get activeRoomId(): string | null {
    return this.roomId;
  }

  async start(roomId: string): Promise<void> {
    this.stop();
    this.roomId = roomId;
    this.items = [];
    this.latest = [];
    this.readState = null;
    this.startedAt = Date.now();
    this.nextBatch = null;
    this.pages = 1;
    this.unsubscribe = this.core.subscribeEvents((event) => {
      if (event.type === 'threads_changed' && event.room_id === roomId) this.refresh();
    });
    await this.load(false);
  }

  stop(): void {
    this.generation += 1;
    this.roomId = null;
    this.fetching = false;
    this.loading = false;
    this.pending = false;
    this.locallyRead.clear();
    this.countedUnread.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  refresh(): void {
    if (this.timer !== undefined || this.roomId === null) return;
    const remaining =
      this.options.lazyPreviews && !this.previewing
        ? this.lastLoad + HEADER_REFRESH_INTERVAL - Date.now()
        : 0;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.fetching) this.pending = true;
        else void this.load(false);
      },
      Math.max(250, remaining)
    );
  }

  retry(): Promise<void> {
    return this.load(false);
  }

  loadMore(): Promise<void> {
    return this.nextBatch === null ? Promise.resolve() : this.load(true);
  }

  private recordLocalRead(rootId: string, eventId: string, timestamp: number): void {
    const previous = this.locallyRead.get(rootId);
    if (!previous || timestamp >= previous.timestamp) {
      this.locallyRead.set(rootId, { eventId, timestamp });
    }
  }

  markRootRead(rootId: string): void {
    const root = this.items.find((entry) => (entry.event_id ?? entry.id) === rootId);
    const latestId = root?.thread_summary?.latest_event_id ?? null;
    const latest = this.latestById.get(latestId);
    this.recordLocalRead(
      rootId,
      latestId ?? rootId,
      root ? threadActivity(root, latest) : Date.now()
    );
  }

  markRead(rootId: string, item: TimelineItemView): void {
    if (!item.event_id) return;
    this.recordLocalRead(rootId, item.event_id, item.timestamp);
  }

  setPreviewing(enabled: boolean): void {
    if (enabled === this.previewing) return;
    this.previewing = enabled;
    if (enabled && this.roomId !== null && this.items.length > 0) {
      void this.hydrateLatest(this.roomId, this.generation, this.items).catch((error: unknown) => {
        console.debug('[sable threads] reply previews unavailable', error);
      });
    }
  }

  private async load(more: boolean): Promise<void> {
    const roomId = this.roomId;
    if (roomId === null || this.fetching) return;
    const generation = ++this.generation;
    this.lastLoad = Date.now();
    this.fetching = true;
    if (more || this.items.length === 0) this.loading = true;
    this.error = false;
    try {
      let from = more ? this.nextBatch : null;
      const roots = more ? [...this.items] : [];
      const pages = more ? 1 : this.pages;
      for (let page = 0; page < pages; page += 1) {
        const response = await this.core.rpc.timeline.listThreads({ room_id: roomId, from });
        if (generation !== this.generation) return;
        roots.push(...response.roots);
        from = response.next_batch;
        if (from === null) break;
      }
      this.items = [
        ...new SvelteMap(roots.map((root) => [root.event_id ?? root.id, root])).values(),
      ];
      this.nextBatch = from;
      if (more) this.pages += 1;
      void this.hydrate(roomId, generation, this.items);
    } catch (error) {
      if (generation === this.generation) {
        this.error = true;
        console.warn('[sable threads] loading threads failed', error);
      }
    } finally {
      if (generation === this.generation) {
        this.fetching = false;
        this.loading = false;
        if (this.pending) {
          this.pending = false;
          this.refresh();
        }
      }
    }
  }

  private async hydrate(
    roomId: string,
    generation: number,
    roots: readonly TimelineItemView[]
  ): Promise<void> {
    const latest =
      !this.options.lazyPreviews || this.previewing
        ? this.hydrateLatest(roomId, generation, roots)
        : Promise.resolve();
    const read = this.core.rpc.timeline
      .unreadDiagnostics({
        room_id: roomId,
        thread_roots: roots.flatMap((root) => (root.event_id ? [root.event_id] : [])),
      })
      .then((state) => {
        if (generation !== this.generation) return;
        this.readState = state;
        void this.hydrateUnreadCounts(roomId, generation, state);
      });
    await Promise.allSettled([latest, read]);
  }

  private async hydrateUnreadCounts(
    roomId: string,
    generation: number,
    readState: UnreadDiagnostics
  ): Promise<void> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup map for one async pass
    const receipts = new Map(readState.threads.map((entry) => [entry.root_event_id, entry]));
    const cutoff = activityCutoff(this.startedAt, readState);
    const userId = this.core.session?.user_id;
    const targets: { rootId: string; receiptId: string | null; key: string; revision: string }[] =
      [];

    for (const root of this.byActivity) {
      if (targets.length >= MAX_COUNTED_THREADS) break;
      const rootId = root.event_id ?? root.id;
      if (!this.activity.has(rootId)) continue;
      const receipt = receipts.get(rootId);
      if ((receipt?.unread ?? 0) > 0) continue;
      const summary = root.thread_summary;
      const latestId = summary?.latest_event_id;
      if (!summary || !latestId || summary.num_replies <= 1) continue;
      const receiptId = receipt?.receipt_event_id ?? null;
      const key = countKey(latestId, receiptId);
      if (this.countedUnread.get(rootId)?.key === key) continue;
      targets.push({ rootId, receiptId, key, revision: threadReplyRevision(summary) });
    }
    if (targets.length === 0) return;

    let cursor = 0;
    const worker = async () => {
      while (generation === this.generation && cursor < targets.length) {
        const next = targets[cursor];
        cursor += 1;
        try {
          const replies = await loadThreadReplies(this.core, roomId, next.rootId, next.revision);
          if (generation !== this.generation) return;
          let count = 0;
          for (const reply of replies) {
            if (next.receiptId && reply.event_id === next.receiptId) break;
            if (userId && reply.sender === userId) break;
            if (reply.timestamp <= cutoff) break;
            count += 1;
          }
          if (replies.length > 0) this.countedUnread.set(next.rootId, { key: next.key, count });
        } catch (error) {
          console.debug('[sable threads] unread count unavailable', error);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(COUNT_CONCURRENCY, targets.length) }, () => worker())
    );
  }

  private async hydrateLatest(
    roomId: string,
    generation: number,
    roots: readonly TimelineItemView[]
  ): Promise<void> {
    const ids = roots.flatMap(({ thread_summary: summary }) =>
      summary?.latest_event_id && (!this.options.lazyPreviews || !summary.latest_body)
        ? [summary.latest_event_id]
        : []
    );
    const requests: Promise<TimelineItemView[]>[] = [];
    for (let start = 0; start < ids.length; start += 50) {
      requests.push(
        this.core.rpc.timeline.eventItems({
          room_id: roomId,
          event_ids: ids.slice(start, start + 50),
        })
      );
    }
    const batches = await Promise.all(requests);
    if (generation === this.generation) this.latest = batches.flat();
  }
}
