import type { InboxFilter, InboxItemView } from '#src/generated/protocol';
import type { CoreCommands } from '#lib/core/commands.svelte.js';

export type InboxFeedCommands = Pick<CoreCommands, 'inboxNotifications' | 'backfillInbox'>;

export class InboxFeed {
  items = $state.raw<InboxItemView[]>([]);
  hasMore = $state(false);
  loaded = $state(false);
  backfilling = $state(false);
  failed = $state(false);
  #revision = 0;

  constructor(private readonly commands: InboxFeedCommands) {}

  async load(filter: InboxFilter, includeRead: boolean, limit: number): Promise<void> {
    const revision = ++this.#revision;
    try {
      const page = await this.commands.inboxNotifications(filter, includeRead, limit);
      if (revision !== this.#revision) return;
      this.items = page.items;
      this.hasMore = page.hasMore;
      this.failed = false;
    } catch (error) {
      if (revision !== this.#revision) return;
      console.warn('[sable inbox] loading notifications failed', error);
      this.failed = true;
    } finally {
      if (revision === this.#revision) this.loaded = true;
    }
  }

  async backfill(includeRead: boolean): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      await this.commands.backfillInbox(includeRead);
    } catch (error) {
      console.warn('[sable inbox] backfilling notifications failed', error);
      this.failed = true;
    } finally {
      this.backfilling = false;
    }
  }
}
