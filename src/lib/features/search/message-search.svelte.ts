import type { SearchHitView } from '#src/generated/SearchHitView';
import type { SearchOrder } from '#src/generated/SearchOrder';

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
const DEBOUNCE_MS = 200;

export interface RoomGroup {
  key: string;
  roomId: string;
  hits: SearchHitView[];
}

export class MessageSearch {
  query = $state('');
  order = $state<SearchOrder>('rank');
  hits = $state<SearchHitView[]>([]);
  searching = $state(false);
  failed = $state(false);
  exhausted = $state(true);

  #core: CoreClient;
  #resolvers: () => QueryResolvers;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

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

    if (this.unresolved.length > 0) {
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
    await this.#run(this.#generation, this.hits.length);
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
      });

      if (generation !== this.#generation) return;

      this.hits = offset === 0 ? page : [...this.hits, ...page];
      this.exhausted = page.length < PAGE_SIZE;
      this.failed = false;
    } catch {
      if (generation !== this.#generation) return;
      if (offset === 0) this.hits = [];
      this.failed = true;
      this.exhausted = true;
    } finally {
      if (generation === this.#generation) this.searching = false;
    }
  }
}
