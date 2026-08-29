import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomTimeline, type BackwardPaginationState } from '#lib/rooms/timeline.svelte.js';

import { collectForumThreads, type ForumThread } from './forum-threads';

export class ForumThreads {
  private readonly timeline: RoomTimeline;

  constructor(private readonly core: CoreClient) {
    this.timeline = new RoomTimeline(core);
  }

  readonly threads: ForumThread[] = $derived.by(() =>
    collectForumThreads(this.timeline.items, this.core.session?.user_id ?? null)
  );

  get loading(): boolean {
    return this.timeline.loading;
  }

  get backwardPagination(): BackwardPaginationState {
    return this.timeline.backwardPagination;
  }

  get roomTimeline(): RoomTimeline {
    return this.timeline;
  }

  start(roomId: string): Promise<void> {
    return this.timeline.start(roomId);
  }

  stop(): Promise<void> {
    return this.timeline.stop();
  }

  paginateBackward(count = 30): Promise<boolean> {
    return this.timeline.paginateBackward(count);
  }
}
