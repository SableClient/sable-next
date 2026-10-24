import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

export const MAX_EMPTY_REFILLS = 5;

export class TimelinePagination {
  exhausted = $state(false);
  pending = $state(false);
  #task: Promise<boolean> | null = null;
  #refillCount: number | null = null;
  #emptyRefills = 0;
  #loadedItemCount = 0;

  constructor(
    private readonly timeline: () => RoomTimeline,
    private readonly request: (count?: number) => Promise<boolean>
  ) {}

  observeItems(): void {
    const loaded = this.timeline().itemCount;
    if (loaded < this.#loadedItemCount) this.exhausted = false;
    this.#loadedItemCount = loaded;
  }

  canRefill(): boolean {
    const count = this.timeline().itemCount;
    if (count !== this.#refillCount) {
      this.#refillCount = count;
      this.#emptyRefills = 0;
    }
    if (this.#emptyRefills >= MAX_EMPTY_REFILLS) return false;
    this.#emptyRefills += 1;
    return true;
  }

  requestHistory(count?: number): Promise<boolean> {
    if (this.#task) return this.#task;
    this.pending = true;
    this.#task = this.request(count).finally(() => {
      this.pending = false;
      this.#task = null;
    });
    return this.#task;
  }
}
