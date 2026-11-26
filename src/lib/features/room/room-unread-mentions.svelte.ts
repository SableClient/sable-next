import { untrack } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { InboxFeed } from '#lib/features/inbox/inbox-feed.svelte.js';
import { timelineMentions } from '#lib/features/inbox/inbox.js';
import { firstRoomSettled } from '#lib/rooms/first-room-gate.js';

const UNREAD_MENTION_LIMIT = 1000;

function loadMentions(feed: InboxFeed): Promise<void> {
  return feed.load('mentions', false, UNREAD_MENTION_LIMIT);
}

export class RoomUnreadMentions {
  #feed: InboxFeed;
  #highlight: number | undefined;
  ids: string[];

  constructor(
    core: Pick<CoreClient, 'rpc' | 'subscribeEvents'>,
    roomId: () => string,
    highlight: () => number | undefined
  ) {
    this.#feed = $derived(new InboxFeed(core.rpc.notifications, roomId()));
    this.ids = $derived(timelineMentions(this.#feed.items));
    $effect(() => {
      const feed = this.#feed;
      this.#highlight = untrack(highlight);
      let disposed = false;
      void firstRoomSettled.then(() => {
        if (disposed) return;
        void loadMentions(feed);
        void feed.backfill(false).then(() => loadMentions(feed));
      });
      const stop = core.subscribeEvents((event) => {
        if (event.type === 'inbox_changed') void loadMentions(feed);
      });
      return () => {
        disposed = true;
        stop();
        feed.dispose();
      };
    });
    // Reading clears mentions without an inbox event, so reload when the room's count moves.
    $effect(() => {
      const count = highlight();
      if (count === this.#highlight) return;
      this.#highlight = count;
      void loadMentions(untrack(() => this.#feed));
    });
  }
}
