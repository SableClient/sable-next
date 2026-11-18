import type { TimelineEntry } from '#lib/timeline/timeline-window.js';

import { holdsEvent, type RowValue } from './timeline-rows.svelte.js';

interface ReturnStackDependencies {
  entries: () => readonly TimelineEntry<RowValue>[];
  lastVisible: () => number | null;
}

/** Messages the reader left by following a reply, most recent first. */
export class TimelineReturnStack {
  #stack = $state.raw<readonly string[]>([]);
  readonly eventId: string | null;

  constructor(deps: ReturnStackDependencies) {
    this.eventId = $derived(
      this.#stack.find((eventId) => {
        const index = deps.entries().findIndex(({ value }) => holdsEvent(value, eventId));
        const lastVisible = deps.lastVisible();
        return index < 0 || lastVisible === null || index > lastVisible;
      }) ?? null
    );
  }

  push(eventId: string): void {
    this.#stack = [eventId, ...this.#stack];
  }

  popThrough(eventId: string): void {
    this.#stack = this.#stack.slice(this.#stack.indexOf(eventId) + 1);
  }

  clear(): void {
    this.#stack = [];
  }
}
