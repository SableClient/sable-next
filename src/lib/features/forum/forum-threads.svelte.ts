import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomTimeline, type BackwardPaginationState } from '#lib/rooms/timeline.svelte.js';

import { ThreadRoots } from '#lib/rooms/thread-roots.svelte.js';

import { collectForumThreads, type ForumThread } from './forum-threads';

const RETRY_DELAYS_MS = [1000, 2000, 4000];

export class ForumThreads {
  private readonly timeline: RoomTimeline;
  private readonly roots: ThreadRoots;
  private session = 0;

  constructor(private readonly core: CoreClient) {
    this.timeline = new RoomTimeline(core);
    this.roots = new ThreadRoots(core);
  }

  readonly threads: ForumThread[] = $derived.by(() =>
    collectForumThreads(
      [...this.timeline.items, ...this.roots.items],
      this.core.session?.user_id ?? null,
      this.roots.latest,
      this.roots.unread
    )
  );

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

  async start(roomId: string): Promise<void> {
    this.session += 1;
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
