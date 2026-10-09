import type { SpaceHierarchyRoomView } from '#src/generated/protocol';
import QuickLRU from 'quick-lru';
import { SvelteSet } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';

const MAX_LEVEL_PAGES = 10;
const HIERARCHY_FRESH_MS = 5 * 60_000;
const MAX_CACHED_LEVELS = 128;

type CachedLevel = { rooms: SpaceHierarchyRoomView[]; fetchedAt: number };

const cachedLevels = new QuickLRU<string, CachedLevel>({ maxSize: MAX_CACHED_LEVELS });
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- request bookkeeping, nothing renders from it
const runningLevels = new Map<string, Promise<SpaceHierarchyRoomView[]>>();

function fetchLevel(
  core: CoreClient,
  key: string,
  levelId: string,
  onPage: (rooms: SpaceHierarchyRoomView[]) => void
): Promise<SpaceHierarchyRoomView[]> {
  const running = runningLevels.get(key);
  if (running) return running;
  const request = (async () => {
    const rooms: SpaceHierarchyRoomView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LEVEL_PAGES; page += 1) {
      const next = await core.commands.spaceHierarchy(levelId, cursor);
      rooms.push(...next.rooms);
      onPage(next.rooms);
      cursor = next.nextBatch;
      if (cursor === null) break;
    }
    if (cursor !== null) console.warn('[sable lobby] level truncated', levelId);
    cachedLevels.set(key, { rooms, fetchedAt: Date.now() });
    return rooms;
  })().finally(() => {
    runningLevels.delete(key);
  });
  runningLevels.set(key, request);
  return request;
}

export class SpaceHierarchyLoader {
  fetched = $state.raw<SpaceHierarchyRoomView[]>([]);
  failed = $state(false);
  loadedLevels = new SvelteSet<string>();
  pendingLevels = new SvelteSet<string>();
  failedLevels = new SvelteSet<string>();

  #spaceId: string | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- enqueue runs inside an effect and probes it, so a reactive set would invalidate that effect on every level it starts
  #requested = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- published through `fetched`
  #levels = new Map<string, SpaceHierarchyRoomView[]>();
  #queue: string[] = [];
  #draining = false;
  #generation = 0;

  constructor(private readonly core: CoreClient) {}

  reset(spaceId: string | null): void {
    if (this.#spaceId === spaceId) return;
    this.#spaceId = spaceId;
    this.#generation += 1;
    this.#requested.clear();
    this.#levels.clear();
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
    let painted = false;
    for (const levelId of levelIds) {
      if (this.#requested.has(levelId)) continue;
      this.#requested.add(levelId);
      const cached = cachedLevels.get(this.#cacheKey(levelId));
      if (cached) {
        this.#levels.set(levelId, cached.rooms);
        this.loadedLevels.add(levelId);
        painted = true;
        if (Date.now() - cached.fetchedAt >= HIERARCHY_FRESH_MS) this.#queue.push(levelId);
        continue;
      }
      this.#queue.push(levelId);
      this.pendingLevels.add(levelId);
    }
    if (painted) this.#publish();
    this.#drain();
  }

  retry(levelId: string): void {
    if (this.#spaceId === null) return;
    if (levelId === this.#spaceId) this.failed = false;
    this.failedLevels.delete(levelId);
    this.loadedLevels.delete(levelId);
    this.#requested.delete(levelId);
    cachedLevels.delete(this.#cacheKey(levelId));
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

  #cacheKey(levelId: string): string {
    return `${this.core.session?.account_id ?? ''}:${levelId}`;
  }

  #publish(): void {
    this.fetched = [...this.#levels.values()].flat();
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
    const refreshing = this.#levels.has(levelId);
    try {
      const rooms = await fetchLevel(this.core, this.#cacheKey(levelId), levelId, (page) => {
        if (refreshing || generation !== this.#generation) return;
        this.#levels.set(levelId, [...(this.#levels.get(levelId) ?? []), ...page]);
        this.#publish();
      });
      if (generation !== this.#generation) return;
      this.#levels.set(levelId, rooms);
      this.#publish();
    } catch (error) {
      if (generation !== this.#generation) return;
      console.warn('[sable lobby] hierarchy unavailable', levelId, error);
      if (!refreshing) {
        if (levelId === this.#spaceId) this.failed = true;
        else this.failedLevels.add(levelId);
      }
    }
    this.pendingLevels.delete(levelId);
    this.loadedLevels.add(levelId);
  }
}
