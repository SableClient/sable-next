import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { TimelineItemView } from '#src/generated/protocol';

export const MAX_EMPTY_REFILLS = 5;

export class TimelinePagination {
  exhausted = $state(false);
  pending = $state(false);
  #task: Promise<boolean> | null = null;
  #refillItems: readonly TimelineItemView[] | null = null;
  #emptyRefills = 0;
  #loadedItemCount = 0;

  constructor(
    private readonly timeline: () => RoomTimeline,
    private readonly request: () => Promise<boolean>
  ) {}

  observeItems(): void {
    const loaded = this.timeline().items.length;
    if (loaded < this.#loadedItemCount) this.exhausted = false;
    this.#loadedItemCount = loaded;
  }

  canRefill(): boolean {
    const items = this.timeline().items;
    if (items !== this.#refillItems) {
      this.#refillItems = items;
      this.#emptyRefills = 0;
    }
    if (this.#emptyRefills >= MAX_EMPTY_REFILLS) return false;
    this.#emptyRefills += 1;
    return true;
  }

  requestHistory(): Promise<boolean> {
    if (this.#task) return this.#task;
    this.pending = true;
    this.#task = this.request().finally(() => {
      this.pending = false;
      this.#task = null;
    });
    return this.#task;
  }
}
