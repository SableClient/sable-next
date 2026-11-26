import { getContext, setContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { ThreadRefView, ThreadSidebarView, TimelineItemView } from '#src/generated/protocol';
import { AccountDataSync } from '#lib/core/account-data-sync.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { replyPreviewBody } from '#lib/features/room/messages/reply-preview.js';
import { i18n } from '#lib/i18n.js';
import { firstRoomSettled, isFirstRoomSettled } from '#lib/rooms/first-room-gate.js';
import { loadThreadReplies, threadReplyRevision } from '#lib/rooms/thread-replies.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import {
  threadActivity,
  THREAD_ACTIVITY_WINDOW,
  type ThreadUnread,
} from '#lib/rooms/thread-roots.svelte.js';

const SIDEBAR_EVENT = 'moe.sable.next.thread_sidebar';
const REFRESH_MS = 60_000;
const MAX_REQUESTS = 3;
const MAX_DISCOVERY_PAGES = 5;
const context = Symbol('thread sidebar');

type ThreadEntry = { id: string; title: string; timestamp: number };
export type SidebarThread = ThreadEntry & { pinned: boolean; unread: boolean };

function threadEntry(item: TimelineItemView): ThreadEntry | null {
  if (!item.event_id) return null;
  return {
    id: item.event_id,
    title: (item.forum_title ?? replyPreviewBody(item.content)).replace(/\s+/g, ' ').trim(),
    timestamp: threadActivity(item),
  };
}

function hasThreadRef(list: readonly ThreadRefView[], roomId: string, rootId: string): boolean {
  return list.some((entry) => entry.room_id === roomId && entry.event_id === rootId);
}

function withoutThreadRef(
  list: readonly ThreadRefView[],
  roomId: string,
  rootId: string
): ThreadRefView[] {
  return list.filter((entry) => entry.room_id !== roomId || entry.event_id !== rootId);
}

export class ThreadSidebar {
  private pins = $state.raw<ThreadRefView[]>([]);
  private dismissed = $state.raw<ThreadRefView[]>([]);
  private readonly participated = new SvelteMap<string, ThreadEntry[]>();
  private readonly details = new SvelteMap<string, Map<string, ThreadEntry>>();
  private readonly unread = new SvelteMap<string, ReadonlyMap<string, ThreadUnread>>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- request bookkeeping not read in templates
  private readonly requested = new Map<
    string,
    { revision: string; time: number; includeActive: boolean }
  >();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- timer handles not read in templates
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- request queue not read in templates
  private readonly queue = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight tracking not read in templates
  private readonly loading = new Set<string>();
  private readonly sync = new AccountDataSync([SIDEBAR_EVENT], (generation) =>
    this.pullSidebar(generation)
  );
  private generation = 0;
  private mutationRevision = 0;
  private confirmed: ThreadSidebarView = { pins: [], dismissed: [] };
  private pendingMutations = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private running = 0;
  private stopEvents: (() => void) | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private now = $state(0);
  ready = $state(false);

  constructor(private readonly core: CoreClient) {}

  start(): void {
    this.stop();
    this.now = Date.now();
    this.stopEvents = this.core.subscribeEvents((event) => {
      if (event.type === 'threads_changed') {
        this.refreshAfterActivity(event.room_id);
      }
    });
    this.sync.start(this.core);
  }

  stop(): void {
    this.generation += 1;
    this.sync.stop();
    this.stopEvents?.();
    this.stopEvents = undefined;
    clearTimeout(this.expiryTimer);
    this.ready = false;
    this.confirmed = { pins: [], dismissed: [] };
    this.pendingMutations = 0;
    this.writeChain = Promise.resolve();
    this.pins = [];
    this.dismissed = [];
    this.participated.clear();
    this.details.clear();
    this.unread.clear();
    this.queue.clear();
    this.loading.clear();
    this.running = 0;
    this.requested.clear();
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
  }

  hasPin(roomId: string, rootId: string): boolean {
    return hasThreadRef(this.pins, roomId, rootId);
  }

  isDismissed(roomId: string, rootId: string): boolean {
    return hasThreadRef(this.dismissed, roomId, rootId);
  }

  isAutoListed(roomId: string, rootId: string): boolean {
    if (!preferences.showActiveThreadsInSidebar) return false;
    if (this.hasPin(roomId, rootId) || this.isDismissed(roomId, rootId)) return false;
    const entry = this.participated.get(roomId)?.find((candidate) => candidate.id === rootId);
    return (
      entry !== undefined && this.activityTime(roomId, entry) > this.now - THREAD_ACTIVITY_WINDOW
    );
  }

  private async applyMutation(
    key: 'pins' | 'dismissed',
    roomId: string,
    rootId: string,
    enabled: boolean,
    mutate: () => Promise<ThreadSidebarView>,
    root?: TimelineItemView | null
  ): Promise<void> {
    if (!this.ready) return;
    const generation = this.generation;
    this.mutationRevision += 1;
    this.pendingMutations += 1;
    if (root) this.remember(roomId, [root]);
    const ref = { room_id: roomId, event_id: rootId };
    const pins =
      key === 'pins' || enabled ? withoutThreadRef(this.pins, roomId, rootId) : this.pins;
    const dismissed =
      key === 'dismissed' || enabled
        ? withoutThreadRef(this.dismissed, roomId, rootId)
        : this.dismissed;
    this.pins = key === 'pins' && enabled ? [...pins, ref] : pins;
    this.dismissed = key === 'dismissed' && enabled ? [...dismissed, ref] : dismissed;
    const run = this.writeChain.then(async () => {
      const result = await mutate();
      if (this.generation !== generation) return;
      this.confirmed = result;
    });
    this.writeChain = run.catch(() => {});
    try {
      await run;
    } finally {
      if (this.generation === generation) {
        this.pendingMutations -= 1;
        if (this.pendingMutations === 0) {
          this.pins = this.confirmed.pins;
          this.dismissed = this.confirmed.dismissed;
        }
      }
    }
  }

  async togglePin(roomId: string, rootId: string, root?: TimelineItemView | null): Promise<void> {
    const pinned = !this.hasPin(roomId, rootId);
    await this.applyMutation(
      'pins',
      roomId,
      rootId,
      pinned,
      () =>
        this.core.rpc.account.setThreadPin({
          room_id: roomId,
          event_id: rootId,
          pinned,
        }),
      root
    );
  }

  async setDismissed(roomId: string, rootId: string, dismissed: boolean): Promise<void> {
    await this.applyMutation('dismissed', roomId, rootId, dismissed, () =>
      this.core.rpc.account.setThreadDismissed({
        room_id: roomId,
        event_id: rootId,
        dismissed,
      })
    );
  }

  remember(roomId: string, roots: readonly TimelineItemView[]): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- snapshot map stored inside SvelteMap
    const entries = new Map(this.details.get(roomId));
    for (const root of roots) {
      const entry = threadEntry(root);
      if (entry) {
        const previous = entries.get(entry.id);
        entries.set(
          entry.id,
          previous && previous.timestamp > entry.timestamp
            ? { ...entry, timestamp: previous.timestamp }
            : entry
        );
      }
    }
    this.details.set(roomId, entries);
  }

  publishUnread(roomId: string, unread: ReadonlyMap<string, ThreadUnread>): void {
    this.unread.set(roomId, unread);
  }

  unreadState(roomId: string, rootId: string): ThreadUnread | undefined {
    return this.unread.get(roomId)?.get(rootId);
  }

  noteReply(roomId: string, rootId: string, root: TimelineItemView | null | undefined): void {
    const entries = this.participated.get(roomId) ?? [];
    const timestamp = Date.now();
    const title = (root && threadEntry(root)?.title) || '';
    this.participated.set(roomId, [
      ...entries.filter((entry) => entry.id !== rootId),
      { id: rootId, title, timestamp },
    ]);
    this.scheduleExpiry();
    if (preferences.showActiveThreadsInSidebar && this.isDismissed(roomId, rootId)) {
      void this.setDismissed(roomId, rootId, false).catch((error: unknown) => {
        console.debug('[sable threads] restoring dismissed thread failed', error);
      });
    }
  }

  private activityTime(roomId: string, entry: ThreadEntry): number {
    return Math.max(entry.timestamp, this.details.get(roomId)?.get(entry.id)?.timestamp ?? 0);
  }

  rows(roomId: string): SidebarThread[] {
    const unread = this.unread.get(roomId);
    const details = this.details.get(roomId);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local accumulation before returning sorted array
    const rows = new Map<string, SidebarThread>();
    if (preferences.showActiveThreadsInSidebar) {
      const cutoff = this.now - THREAD_ACTIVITY_WINDOW;
      for (const entry of this.participated.get(roomId) ?? []) {
        if (this.isDismissed(roomId, entry.id)) continue;
        const detail = details?.get(entry.id);
        const timestamp = Math.max(entry.timestamp, detail?.timestamp ?? 0);
        if (timestamp <= cutoff) continue;
        rows.set(entry.id, {
          ...(detail ?? entry),
          timestamp,
          pinned: false,
          unread: unread?.has(entry.id) ?? false,
        });
      }
    }
    for (const pin of this.pins) {
      if (pin.room_id !== roomId) continue;
      const entry = rows.get(pin.event_id) ??
        details?.get(pin.event_id) ?? {
          id: pin.event_id,
          title: '',
          timestamp: 0,
        };
      rows.set(entry.id, { ...entry, pinned: true, unread: unread?.has(entry.id) ?? false });
    }
    return [...rows.values()].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.timestamp - a.timestamp
    );
  }

  discover(
    roomId: string,
    revision: string,
    includeActive = preferences.showActiveThreadsInSidebar
  ): void {
    if (this.stopEvents === undefined) return;
    const previous = this.requested.get(roomId);
    if (
      previous?.revision === revision &&
      previous.includeActive === includeActive &&
      Date.now() - previous.time < REFRESH_MS
    ) {
      return;
    }
    clearTimeout(this.refreshTimers.get(roomId));
    this.refreshTimers.delete(roomId);
    this.requested.set(roomId, { revision, time: Date.now(), includeActive });
    this.queue.add(roomId);
    this.drain();
  }

  private refreshAfterActivity(roomId: string): void {
    if (!preferences.showActiveThreadsInSidebar) return;
    const room = this.requested.get(roomId);
    if (!room || this.refreshTimers.has(roomId)) return;
    const remaining = room.time + REFRESH_MS - Date.now();
    if (remaining <= 0) {
      this.discover(roomId, room.revision, true);
      return;
    }
    this.refreshTimers.set(
      roomId,
      setTimeout(() => {
        this.refreshTimers.delete(roomId);
        this.discover(roomId, room.revision, true);
      }, remaining)
    );
  }

  private drain(): void {
    if (!isFirstRoomSettled()) {
      const generation = this.generation;
      void firstRoomSettled.then(() => {
        if (generation === this.generation) this.drain();
      });
      return;
    }
    while (this.running < MAX_REQUESTS && this.queue.size > 0) {
      const roomId = [...this.queue].find((id) => !this.loading.has(id));
      if (roomId === undefined) return;
      this.queue.delete(roomId);
      this.loading.add(roomId);
      this.running += 1;
      const generation = this.generation;
      void this.loadRoom(roomId).finally(() => {
        if (generation !== this.generation) return;
        this.running -= 1;
        this.loading.delete(roomId);
        this.drain();
      });
    }
  }

  private async loadRoom(roomId: string): Promise<void> {
    const generation = this.generation;
    const includeActive =
      this.requested.get(roomId)?.includeActive ?? preferences.showActiveThreadsInSidebar;
    const startedAt = Date.now();
    const cutoff = startedAt - THREAD_ACTIVITY_WINDOW;
    try {
      if (!includeActive) return;
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local accumulation for one async load
      const entries = new Map<string, ThreadEntry>();
      const candidates: { entry: ThreadEntry; revision: string }[] = [];
      const userId = this.core.session?.user_id;
      let from: string | null = null;
      let pages = 0;
      do {
        pages += 1;
        const page = await this.core.rpc.timeline.listThreads({
          room_id: roomId,
          from,
          participated: true,
        });
        if (generation !== this.generation) return;
        for (const root of page.roots) {
          const entry = threadEntry(root);
          if (!entry || entry.timestamp <= cutoff) continue;
          const summary = root.thread_summary;
          if (!summary || summary.num_replies <= 0) continue;
          if (
            root.is_own ||
            (userId != null && summary.latest_sender === userId) ||
            (summary.current_user_participated === true && userId == null)
          ) {
            entries.set(entry.id, entry);
          } else if (summary.current_user_participated === true && summary.num_replies > 1) {
            candidates.push({
              entry,
              revision: threadReplyRevision(summary),
            });
          }
        }
        this.remember(roomId, page.roots);
        const last = page.roots[page.roots.length - 1]?.thread_summary?.latest_timestamp;
        const reachedOlderActivity = last != null && last <= cutoff;
        from = reachedOlderActivity || page.next_batch === from ? null : page.next_batch;
      } while (from !== null && pages < MAX_DISCOVERY_PAGES);
      if (userId != null && candidates.length > 0) {
        const verified = await Promise.all(
          candidates.map(async ({ entry, revision }) => {
            try {
              const replies = await loadThreadReplies(this.core, roomId, entry.id, revision);
              return replies.length === 0 || replies.some((reply) => reply.sender === userId)
                ? entry
                : null;
            } catch {
              return entry;
            }
          })
        );
        if (generation !== this.generation) return;
        for (const entry of verified) {
          if (entry) entries.set(entry.id, entry);
        }
      }
      for (const entry of this.participated.get(roomId) ?? []) {
        if (
          entry.timestamp >= startedAt &&
          entry.timestamp > (entries.get(entry.id)?.timestamp ?? 0)
        ) {
          entries.set(entry.id, entry);
        }
      }
      this.participated.set(roomId, [...entries.values()]);
      this.scheduleExpiry();
    } catch (error) {
      console.debug('[sable threads] sidebar activity unavailable', error);
    } finally {
      if (generation === this.generation) void this.loadPinDetails(roomId, generation);
    }
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.now = Date.now();
    let next = Infinity;
    for (const [roomId, entries] of this.participated) {
      for (const entry of entries) {
        const expires = this.activityTime(roomId, entry) + THREAD_ACTIVITY_WINDOW;
        if (expires > this.now) next = Math.min(next, expires);
      }
    }
    if (Number.isFinite(next)) {
      this.expiryTimer = setTimeout(
        () => {
          this.scheduleExpiry();
        },
        Math.min(next - this.now, 0x7fffffff)
      );
    }
  }

  private async loadPinDetails(roomId: string, generation: number): Promise<void> {
    const details = this.details.get(roomId);
    const eventIds = this.pins
      .filter((pin) => pin.room_id === roomId && !details?.has(pin.event_id))
      .map((pin) => pin.event_id);
    try {
      for (let offset = 0; offset < eventIds.length; offset += 50) {
        const roots = await this.core.rpc.timeline.eventItems({
          room_id: roomId,
          event_ids: eventIds.slice(offset, offset + 50),
        });
        if (generation !== this.generation) return;
        this.remember(roomId, roots);
      }
    } catch (error) {
      console.debug('[sable threads] pinned thread details unavailable', error);
    }
  }

  private async pullSidebar(syncGeneration: number): Promise<void> {
    const generation = this.generation;
    const revision = this.mutationRevision;
    try {
      const state = await this.core.rpc.account.threadSidebar();
      if (
        syncGeneration !== this.sync.generation ||
        generation !== this.generation ||
        this.pendingMutations > 0 ||
        revision !== this.mutationRevision
      ) {
        return;
      }
      this.confirmed = state;
      this.pins = state.pins;
      this.dismissed = state.dismissed;
      this.ready = true;
      for (const roomId of this.requested.keys()) void this.loadPinDetails(roomId, generation);
    } catch (error) {
      console.debug('[sable threads] sidebar state unavailable', error);
    }
  }
}

export function saveThreadSidebarAction(
  work: Promise<void> | undefined,
  failKey: 'timeline.threadPinFailed' | 'timeline.threadDismissFailed',
  context: string
): void {
  void work?.catch((error: unknown) => {
    console.warn(`[sable threads] ${context} could not be saved`, error);
    toasts.error(i18n.t(failKey));
  });
}

export function provideThreadSidebar(sidebar: ThreadSidebar): void {
  setContext(context, sidebar);
}

export function useThreadSidebar(): ThreadSidebar | undefined {
  return getContext<ThreadSidebar | undefined>(context);
}
