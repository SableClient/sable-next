import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { TimelineItemView } from '#src/generated/protocol';
import { MAX_EMPTY_REFILLS } from './timeline-pagination.svelte.js';

export class TimelineFuture {
  pending = $state(false);
  failed = $state(false);
  #task: Promise<void> | null = null;
  #items: readonly TimelineItemView[] | null = null;
  #emptyRequests = 0;

  constructor(
    private readonly timeline: () => RoomTimeline,
    private readonly load: () => Promise<void>
  ) {}

  canRefill(): boolean {
    const items = this.timeline().items;
    if (items !== this.#items) {
      this.#items = items;
      this.#emptyRequests = 0;
    }
    return !this.failed && this.#emptyRequests < MAX_EMPTY_REFILLS;
  }

  request(manual = false): Promise<void> {
    if (this.#task) return this.#task;
    if (manual) {
      this.failed = false;
      this.#emptyRequests = 0;
    }
    if (!this.canRefill()) return Promise.resolve();
    this.#emptyRequests += 1;
    this.pending = true;
    const task: Promise<void> = Promise.resolve()
      .then(() => (this.#task === task ? this.load() : undefined))
      .catch((error: unknown) => {
        if (this.#task === task) this.failed = true;
        throw error;
      })
      .finally(() => {
        if (this.#task !== task) return;
        this.#task = null;
        this.pending = false;
      });
    this.#task = task;
    return task;
  }

  reset(): void {
    this.#task = null;
    this.#items = null;
    this.#emptyRequests = 0;
    this.pending = false;
    this.failed = false;
  }
}
