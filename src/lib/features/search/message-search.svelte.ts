import type { SearchCoverageView, SearchHitView, SearchOrder } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { searchMessages } from '#lib/core/api/search.svelte.js';

import {
  parseSearchQuery,
  resolveSearchQuery,
  type ParsedQuery,
  type ResolvedQuery,
  type SearchDirectory,
  type SearchToken,
} from './search-query';

const PAGE_SIZE = 30;
const CONTEXT_LINES = 1;
const DEBOUNCE_MS = 200;
const REFRESH_MS = 1_000;

export const MESSAGE_SEARCH_FIELD_ID = 'message-search-field';

function uniqueHits(hits: SearchHitView[]): SearchHitView[] {
  return hits.filter(
    (hit, index) => hits.findIndex((other) => other.event_id === hit.event_id) === index
  );
}

export interface RoomGroup {
  key: string;
  roomId: string;
  hits: SearchHitView[];
}

export class MessageSearch {
  query = $state('');
  order = $state<SearchOrder>('recent');
  hits = $state.raw<SearchHitView[]>([]);
  searching = $state(false);
  refining = $state(false);
  failed = $state(false);
  pageFailed = $state(false);
  refreshAvailable = $state(false);
  exhausted = $state(true);
  older = $state(false);
  pages = $state(0);

  #core: CoreClient;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #coverage: SearchCoverageView | null;
  #paginated = false;
  #generation = 0;
  #served = 0;
  #olderCursor: string | null = null;
  readonly resolved: ResolvedQuery;

  constructor(core: CoreClient, directory: () => SearchDirectory) {
    this.#core = core;
    this.#coverage = core.searchCoverage ?? null;
    this.resolved = $derived(resolveSearchQuery(this.query, directory()));
  }

  get parsed(): ParsedQuery {
    return parseSearchQuery(this.query);
  }

  get unresolved(): SearchToken[] {
    return this.resolved.unresolved;
  }

  get groups(): RoomGroup[] {
    const groups: RoomGroup[] = [];

    for (const hit of this.hits) {
      const last = groups.at(-1);
      if (last?.roomId === hit.room_id) last.hits.push(hit);
      else
        groups.push({ key: `${hit.room_id}/${groups.length}`, roomId: hit.room_id, hits: [hit] });
    }

    return groups;
  }

  get runnable(): boolean {
    const { text, phrases, tokens } = this.parsed;
    return text.trim() !== '' || phrases.length > 0 || tokens.length > 0;
  }

  schedule(): void {
    clearTimeout(this.#debounce);
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#paginated = false;
    this.refreshAvailable = false;
    this.failed = false;
    this.pageFailed = false;
    const generation = ++this.#generation;

    if (!this.runnable || this.unresolved.length > 0 || this.resolved.matches_nothing) {
      this.hits = [];
      this.searching = false;
      this.refining = false;
      this.exhausted = true;
      return;
    }

    this.searching = true;
    this.refining = true;
    this.#debounce = setTimeout(() => void this.#run(generation), DEBOUNCE_MS);
  }

  setOrder(order: SearchOrder): void {
    if (this.order === order) return;
    this.order = order;
    this.schedule();
  }

  async loadMore(): Promise<void> {
    if (this.searching || this.exhausted || this.pageFailed || this.failed) return;

    this.#paginated = true;
    this.searching = true;
    if (this.older && this.#olderCursor !== null) {
      await this.#runOlder(this.#generation, this.#olderCursor);
    } else {
      await this.#run(this.#generation, this.#served);
    }
  }

  async retryPage(): Promise<void> {
    if (!this.pageFailed || this.searching) return;
    this.pageFailed = false;
    await this.loadMore();
  }

  refresh(): void {
    if (
      !this.runnable ||
      this.searching ||
      this.unresolved.length > 0 ||
      this.resolved.matches_nothing
    )
      return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#paginated = false;
    this.refreshAvailable = false;
    this.failed = false;
    this.pageFailed = false;
    this.searching = true;
    this.refining = true;
    void this.#run(++this.#generation, 0, true);
  }

  updateCoverage(coverage: SearchCoverageView | null): void {
    const previous = this.#coverage;
    this.#coverage = coverage;
    if (
      !coverage ||
      (previous?.documents === coverage.documents && previous.state === coverage.state)
    )
      return;
    if (!this.runnable || this.unresolved.length > 0 || this.resolved.matches_nothing) return;
    this.refreshAvailable = true;
    if (!this.#paginated && !this.failed && !this.pageFailed) this.#queueRefresh();
  }

  #queueRefresh(): void {
    if (this.#refreshTimer !== undefined) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      if (!this.refreshAvailable || this.#paginated || this.failed || this.pageFailed) return;
      if (this.searching) this.#queueRefresh();
      else this.refresh();
    }, REFRESH_MS);
  }

  dispose(): void {
    clearTimeout(this.#debounce);
    clearTimeout(this.#refreshTimer);
    this.#generation += 1;
  }

  async #run(generation: number, offset = 0, preserveResults = false): Promise<void> {
    const { text } = this.parsed;

    try {
      const page = await searchMessages(this.#core.rpc, text, {
        filter: this.resolved.filter,
        order: this.order,
        limit: PAGE_SIZE,
        offset,
        context: CONTEXT_LINES,
      });

      if (generation !== this.#generation) return;

      if (offset === 0) {
        this.hits = uniqueHits(page.hits);
        this.#olderCursor = page.older;
      } else {
        this.#append(page.hits);
      }
      this.#served = offset + page.hits.length;
      this.older = page.hits.length < PAGE_SIZE && this.#olderCursor !== null;
      this.exhausted = page.hits.length < PAGE_SIZE && !this.older;
      this.failed = false;
      this.pageFailed = false;
      this.pages += 1;
    } catch (error) {
      console.warn('[sable search] searching messages failed', error);
      if (generation !== this.#generation) return;
      if (offset === 0) {
        if (!preserveResults) {
          this.hits = [];
          this.exhausted = true;
        }
        this.failed = true;
      } else {
        this.pageFailed = true;
      }
    } finally {
      if (generation === this.#generation) {
        this.searching = false;
        if (offset === 0) this.refining = false;
      }
    }
  }

  async #runOlder(generation: number, cursor: string): Promise<void> {
    try {
      const page = await searchMessages(this.#core.rpc, this.parsed.text, {
        filter: this.resolved.filter,
        order: this.order,
        limit: PAGE_SIZE,
        context: CONTEXT_LINES,
        older: cursor,
      });
      if (generation !== this.#generation) return;
      this.#append(page.hits);
      this.#olderCursor = page.older;
      this.older = page.older !== null;
      this.exhausted = page.older === null;
      this.failed = false;
      this.pageFailed = false;
      this.pages += 1;
    } catch (error) {
      console.warn('[sable search] loading older results failed', error);
      if (generation !== this.#generation) return;
      this.pageFailed = true;
    } finally {
      if (generation === this.#generation) this.searching = false;
    }
  }

  #append(hits: SearchHitView[]): void {
    this.hits = uniqueHits([...this.hits, ...hits]);
  }
}
