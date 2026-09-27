import type { SpaceHierarchyRoomView } from '#src/generated/protocol';
import { SvelteSet } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';

const MAX_LEVEL_PAGES = 10;

export class SpaceHierarchyLoader {
  fetched = $state.raw<SpaceHierarchyRoomView[]>([]);
  failed = $state(false);
  loadedLevels = new SvelteSet<string>();
  pendingLevels = new SvelteSet<string>();
  failedLevels = new SvelteSet<string>();

  #spaceId: string | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- enqueue runs inside an effect and probes it, so a reactive set would invalidate that effect on every level it starts
  #requested = new Set<string>();
  #queue: string[] = [];
  #draining = false;
  #generation = 0;

  constructor(private readonly core: CoreClient) {}

  reset(spaceId: string | null): void {
    if (this.#spaceId === spaceId) return;
    this.#spaceId = spaceId;
    this.#generation += 1;
    this.#requested.clear();
    this.#queue = [];
    this.#draining = false;
    this.fetched = [];
    this.failed = false;
    this.loadedLevels.clear();
    this.pendingLevels.clear();
    this.failedLevels.clear();
  }

  enqueue(levelIds: readonly string[]): void {
    if (this.#spaceId === null) return;
    for (const levelId of levelIds) {
      if (this.#requested.has(levelId)) continue;
      this.#requested.add(levelId);
      this.#queue.push(levelId);
      this.pendingLevels.add(levelId);
    }
    this.#drain();
  }

  retry(levelId: string): void {
    if (this.#spaceId === null) return;
    if (levelId === this.#spaceId) this.failed = false;
    this.failedLevels.delete(levelId);
    this.loadedLevels.delete(levelId);
    this.#requested.delete(levelId);
    this.enqueue([levelId]);
  }

  fail(): void {
    this.failed = true;
  }

  dispose(): void {
    this.#generation += 1;
    this.#queue = [];
    this.#spaceId = null;
  }

  #drain(): void {
    if (this.#draining || this.#queue.length === 0) return;
    this.#draining = true;
    const generation = this.#generation;
    void this.#loadQueued(generation);
  }

  async #loadQueued(generation: number): Promise<void> {
    try {
      while (generation === this.#generation) {
        const levelId = this.#queue.shift();
        if (levelId === undefined) return;
        await this.#loadLevel(levelId, generation);
      }
    } finally {
      if (generation === this.#generation) {
        this.#draining = false;
        this.#drain();
      }
    }
  }

  async #loadLevel(levelId: string, generation: number): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LEVEL_PAGES; page += 1) {
      try {
        const next = await this.core.commands.spaceHierarchy(levelId, cursor);
        if (generation !== this.#generation) return;
        this.fetched = [...this.fetched, ...next.rooms];
        cursor = next.nextBatch;
      } catch (error) {
        if (generation !== this.#generation) return;
        console.warn('[sable lobby] hierarchy unavailable', levelId, error);
        if (levelId === this.#spaceId) this.failed = true;
        else this.failedLevels.add(levelId);
        break;
      }
      if (cursor === null) break;
    }
    if (cursor !== null) console.warn('[sable lobby] level truncated', levelId);
    if (generation !== this.#generation) return;
    this.pendingLevels.delete(levelId);
    this.loadedLevels.add(levelId);
  }
}
