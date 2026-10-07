import type { InboxFilter, InboxItemView } from '#src/generated/protocol';
import { SvelteSet } from 'svelte/reactivity';
import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { NOTIFICATION_GROUP_LIMIT } from './inbox';

export type InboxFeedCommands = Pick<CoreCommands, 'inboxNotifications' | 'backfillInbox'>;

export class InboxFeed {
  items = $state.raw<InboxItemView[]>([]);
  hasMore = $state(false);
  loaded = $state(false);
  backfilling = $state(false);
  checked = $state(false);
  #loadFailed = $state(false);
  #backfillFailed = $state(false);
  failed = $derived(this.#loadFailed || this.#backfillFailed);
  #revision = 0;
  #rerun: boolean[] = [];
  #running: Promise<void> | null = null;
  #disposed = false;

  constructor(private readonly commands: InboxFeedCommands) {}

  async load(filter: InboxFilter, includeRead: boolean, limit: number): Promise<void> {
    if (this.#disposed) return;
    const revision = ++this.#revision;
    try {
      let queryLimit = limit * NOTIFICATION_GROUP_LIMIT;
      for (;;) {
        const page = await this.commands.inboxNotifications(filter, includeRead, queryLimit);
        if (revision !== this.#revision) return;
        const groups = new SvelteSet(page.items.map((item) => item.room_id)).size;
        if (page.hasMore && groups < limit && page.items.length >= queryLimit) {
          queryLimit *= 2;
          continue;
        }
        this.items = page.items;
        this.hasMore = page.hasMore || groups > limit;
        break;
      }
      this.#loadFailed = false;
    } catch (error) {
      if (revision !== this.#revision) return;
      console.warn('[sable inbox] loading notifications failed', error);
      this.#loadFailed = true;
    } finally {
      if (revision === this.#revision) this.loaded = true;
    }
  }

  backfill(includeRead: boolean): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#running) {
      if (!this.#rerun.includes(includeRead)) this.#rerun.push(includeRead);
      return this.#running;
    }
    this.#running = this.#backfill(includeRead).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  dispose(): void {
    this.#disposed = true;
    this.#revision += 1;
    this.#rerun = [];
  }

  async #backfill(includeRead: boolean, hadFailure = false): Promise<void> {
    this.backfilling = true;
    try {
      let more: boolean;
      do {
        const page = await this.commands.backfillInbox(includeRead);
        more = !includeRead && page.hasMore;
      } while (more && !this.#disposed);
    } catch (error) {
      console.warn('[sable inbox] backfilling notifications failed', error);
      hadFailure = true;
    } finally {
      this.#backfillFailed = hadFailure;
      this.backfilling = false;
      this.checked = true;
    }
    const rerun = this.#rerun.shift();
    if (rerun !== undefined && !this.#disposed) {
      await this.#backfill(rerun, hadFailure);
    }
  }
}
