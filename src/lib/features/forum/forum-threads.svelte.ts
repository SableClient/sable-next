import { SvelteMap } from 'svelte/reactivity';

import type { ReactionGroup } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomTimeline, type BackwardPaginationState } from '#lib/rooms/timeline.svelte.js';

import { ThreadRoots } from '#lib/rooms/thread-roots.svelte.js';

import { collectForumThreads, type ForumThread } from './forum-threads';

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const REACTION_CONCURRENCY = 4;

export class ForumThreads {
  private readonly timeline: RoomTimeline;
  private readonly roots: ThreadRoots;
  private session = 0;
  private readonly listedReactions = new SvelteMap<string, readonly ReactionGroup[]>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping that is never rendered
  private readonly requestedReactions = new Set<string>();
  private reactionQueue: string[] = [];
  private reactionWorkers = 0;

  constructor(private readonly core: CoreClient) {
    this.timeline = new RoomTimeline(core);
    this.roots = new ThreadRoots(core);
  }

  readonly threads: ForumThread[] = $derived.by(() => {
    const loaded = this.timeline.items.map((item) => item.event_id);
    return collectForumThreads(
      [...this.timeline.items, ...this.roots.items],
      this.core.session?.user_id ?? null,
      this.roots.latest,
      this.roots.unread,
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived index rebuilt from reactive inputs
      new Map([...this.listedReactions].filter(([eventId]) => !loaded.includes(eventId)))
    );
  });

  get loading(): boolean {
    return this.timeline.loading || this.roots.loading;
  }

  get canLoadMore(): boolean {
    return this.roots.nextBatch !== null || this.timeline.backwardPagination !== 'end';
  }

  get error(): boolean {
    return this.timeline.error !== null || this.roots.error;
  }

  async retry(): Promise<void> {
    await Promise.all([this.timeline.retry(), this.roots.retry()]);
  }

  get backwardPagination(): BackwardPaginationState {
    return this.timeline.backwardPagination;
  }

  get roomTimeline(): RoomTimeline {
    return this.timeline;
  }

  /** Fetches the reactions of listed posts the timeline has not loaded, once per post. */
  loadListedReactions(): void {
    const roomId = this.roots.activeRoomId;
    // Posts the timeline is about to load bring their own reactions.
    if (roomId === null || this.loading) return;
    const loaded = this.timeline.items.map((item) => item.event_id);
    for (const root of this.roots.items) {
      const eventId = root.event_id;
      if (eventId === null || loaded.includes(eventId) || this.requestedReactions.has(eventId))
        continue;
      this.requestedReactions.add(eventId);
      this.reactionQueue.push(eventId);
    }
    while (this.reactionWorkers < REACTION_CONCURRENCY && this.reactionQueue.length > 0) {
      this.reactionWorkers += 1;
      void this.drainReactions(roomId, this.session);
    }
  }

  /** Reads a listed post's reactions again, after the user changed theirs. */
  async refreshReactions(eventId: string): Promise<void> {
    const roomId = this.roots.activeRoomId;
    if (roomId === null || !this.requestedReactions.has(eventId)) return;
    await this.fetchReactions(roomId, eventId, this.session);
  }

  private async drainReactions(roomId: string, session: number): Promise<void> {
    try {
      while (session === this.session) {
        const eventId = this.reactionQueue.shift();
        if (eventId === undefined) return;
        await this.fetchReactions(roomId, eventId, session);
      }
    } finally {
      if (session === this.session) this.reactionWorkers -= 1;
    }
  }

  private async fetchReactions(roomId: string, eventId: string, session: number): Promise<void> {
    try {
      const reactions = await this.core.rpc.messages.eventReactions({
        room_id: roomId,
        event_id: eventId,
      });
      if (session === this.session) this.listedReactions.set(eventId, reactions);
    } catch (error) {
      console.debug('[sable forum] reactions of a listed post unavailable', error);
    }
  }

  async start(roomId: string): Promise<void> {
    this.session += 1;
    this.listedReactions.clear();
    this.requestedReactions.clear();
    this.reactionQueue = [];
    this.reactionWorkers = 0;
    await Promise.all([this.timeline.start(roomId), this.roots.start(roomId)]);
  }

  stop(): Promise<void> {
    this.session += 1;
    this.roots.stop();
    return this.timeline.stop();
  }

  async paginateBackward(count = 30): Promise<boolean> {
    const session = this.session;
    await Promise.all([this.timeline.paginateBackward(count), this.roots.loadMore()]).catch(
      () => {}
    );
    for (const delay of RETRY_DELAYS_MS) {
      if (!this.error) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (session !== this.session) break;
      await this.retry();
    }
    if (this.error) throw new Error('Unable to load forum threads');
    return this.timeline.backwardPagination === 'end';
  }
}
