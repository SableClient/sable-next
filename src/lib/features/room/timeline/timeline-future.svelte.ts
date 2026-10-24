import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

export class TimelineFuture {
  pending = $state(false);
  failed = $state(false);
  #task: Promise<void> | null = null;
  #requestedCount: number | null = null;

  constructor(
    private readonly timeline: () => RoomTimeline,
    private readonly load: () => Promise<void>
  ) {}

  canRefill(): boolean {
    return !this.failed && this.timeline().itemCount !== this.#requestedCount;
  }

  request(manual = false): Promise<void> {
    if (this.#task) return this.#task;
    if (manual) {
      this.failed = false;
      this.#requestedCount = null;
    }
    if (!this.canRefill()) return Promise.resolve();
    this.#requestedCount = this.timeline().itemCount;
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
    this.#requestedCount = null;
    this.pending = false;
    this.failed = false;
  }
}
