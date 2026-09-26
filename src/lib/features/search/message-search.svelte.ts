import type { SearchHitView, SearchOrder } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import {
  parseSearchQuery,
  toSearchFilter,
  type ParsedQuery,
  type QueryResolvers,
  type ResolvedQuery,
  type SearchToken,
} from './search-query';

const PAGE_SIZE = 30;
const CONTEXT_LINES = 1;
const DEBOUNCE_MS = 200;

export const MESSAGE_SEARCH_FIELD_ID = 'message-search-field';

export interface RoomGroup {
  key: string;
  roomId: string;
  hits: SearchHitView[];
}

export class MessageSearch {
  query = $state('');
  order = $state<SearchOrder>('rank');
  hits = $state.raw<SearchHitView[]>([]);
  searching = $state(false);
  failed = $state(false);
  exhausted = $state(true);
  older = $state(false);
  pages = $state(0);

  #core: CoreClient;
  #resolvers: () => QueryResolvers;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #served = 0;
  #olderCursor: string | null = null;

  constructor(core: CoreClient, resolvers: () => QueryResolvers) {
    this.#core = core;
    this.#resolvers = resolvers;
  }

  get parsed(): ParsedQuery {
    return parseSearchQuery(this.query);
  }

  get resolved(): ResolvedQuery {
    return toSearchFilter(this.parsed, this.#resolvers());
  }

  get unresolved(): SearchToken[] {
    return this.resolved.unresolved;
  }

  get groups(): RoomGroup[] {
    const groups: RoomGroup[] = [];

    for (const hit of this.hits) {
      const last = groups.at(-1);
      if (last?.roomId === hit.room_id) last.hits.push(hit);
      else groups.push({ key: `${hit.room_id}/${hit.event_id}`, roomId: hit.room_id, hits: [hit] });
    }

    return groups;
  }

  get runnable(): boolean {
    const { text, phrases, tokens } = this.parsed;
    return text.trim() !== '' || phrases.length > 0 || tokens.length > 0;
  }

  schedule(): void {
    clearTimeout(this.#debounce);
    const generation = ++this.#generation;

    if (!this.runnable) {
      this.hits = [];
      this.searching = false;
      this.failed = false;
      this.exhausted = true;
      return;
    }

    if (this.unresolved.length > 0 || this.resolved.matchesNothing) {
      this.hits = [];
      this.searching = false;
      this.failed = false;
      this.exhausted = true;
      return;
    }

    this.searching = true;
    this.#debounce = setTimeout(() => void this.#run(generation), DEBOUNCE_MS);
  }

  setOrder(order: SearchOrder): void {
    if (this.order === order) return;
    this.order = order;
    this.schedule();
  }

  async loadMore(): Promise<void> {
    if (this.searching || this.exhausted) return;

    this.searching = true;
    if (this.older && this.#olderCursor !== null) {
      await this.#runOlder(this.#generation, this.#olderCursor);
    } else {
      await this.#run(this.#generation, this.#served);
    }
  }

  dispose(): void {
    clearTimeout(this.#debounce);
    this.#generation += 1;
  }

  async #run(generation: number, offset = 0): Promise<void> {
    const { text } = this.parsed;

    try {
      const page = await this.#core.commands.searchMessages(text, {
        filter: this.resolved.filter,
        order: this.order,
        limit: PAGE_SIZE,
        offset,
        context: CONTEXT_LINES,
      });

      if (generation !== this.#generation) return;

      if (offset === 0) {
        this.hits = page.hits;
        this.#olderCursor = page.older;
      } else {
        this.#append(page.hits);
      }
      this.#served = offset + page.hits.length;
      this.older = page.hits.length < PAGE_SIZE && this.#olderCursor !== null;
      this.exhausted = page.hits.length < PAGE_SIZE && !this.older;
      this.failed = false;
      this.pages += 1;
    } catch {
      if (generation !== this.#generation) return;
      if (offset === 0) this.hits = [];
      this.failed = true;
      this.exhausted = true;
    } finally {
      if (generation === this.#generation) this.searching = false;
    }
  }

  async #runOlder(generation: number, cursor: string): Promise<void> {
    try {
      const page = await this.#core.commands.searchMessages(this.parsed.text, {
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
      this.pages += 1;
    } catch {
      if (generation !== this.#generation) return;
      this.failed = true;
      this.exhausted = true;
    } finally {
      if (generation === this.#generation) this.searching = false;
    }
  }

  #append(hits: SearchHitView[]): void {
    const loaded = this.hits;
    const unseen = hits.filter((hit) => !loaded.some((kept) => kept.event_id === hit.event_id));
    this.hits = [...loaded, ...unseen];
  }
}
