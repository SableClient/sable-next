import type { InboxFilter, InboxItemView, Rpc } from '#src/generated/protocol';
import { SvelteSet } from 'svelte/reactivity';
import { NOTIFICATION_GROUP_LIMIT } from './inbox';

export type InboxFeedCommands = Pick<Rpc['notifications'], 'inbox' | 'backfillInbox'>;

export class InboxFeed {
  items = $state.raw<InboxItemView[]>([]);
  hasMore = $state(false);
  loaded = $state(false);
  backfilling = $state(false);
  checked = $state(false);
  olderHistory = $state(true);
  #loadFailed = $state(false);
  #backfillFailed = $state(false);
  failed = $derived(this.#loadFailed || this.#backfillFailed);
  #revision = 0;
  #rerun: boolean[] = [];
  #running: Promise<void> | null = null;
  #disposed = false;

  /** A feed for `roomId` counts `limit` in events instead of rooms. */
  constructor(
    private readonly commands: InboxFeedCommands,
    private readonly roomId: string | null = null
  ) {}

  async load(filter: InboxFilter, includeRead: boolean, limit: number, query = ''): Promise<void> {
    if (this.#disposed) return;
    const revision = ++this.#revision;
    try {
      let queryLimit = this.roomId === null ? limit * NOTIFICATION_GROUP_LIMIT : limit;
      for (;;) {
        const page = await this.commands.inbox({
          filter,
          include_read: includeRead,
          limit: queryLimit,
          before_ts: null,
          room_id: this.roomId,
          query: query === '' ? null : query,
        });
        if (revision !== this.#revision) return;
        if (this.roomId !== null) {
          this.items = page.items;
          this.hasMore = page.has_more;
          break;
        }
        const groups = new SvelteSet(page.items.map((item) => item.room_id)).size;
        if (page.has_more && groups < limit && page.items.length >= queryLimit) {
          queryLimit *= 2;
          continue;
        }
        this.items = page.items;
        this.hasMore = page.has_more || groups > limit;
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
        const page = await this.commands.backfillInbox({
          include_read: includeRead,
          room_id: this.roomId,
        });
        if (includeRead) this.olderHistory = page.has_more;
        more = !includeRead && page.has_more;
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
