import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { TimelineItemView } from '#src/generated/protocol';

import type { CoreCommands } from '#lib/core/commands.svelte.js';

export type EventItemCommands = Pick<CoreCommands, 'eventItems'>;

export class EventItems {
  readonly #items = new SvelteMap<string, TimelineItemView | null>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a request queue nothing renders from
  readonly #queued = new Map<string, Set<string>>();
  #flushing = false;

  constructor(
    private readonly commands: EventItemCommands,
    private readonly owner: () => string | null
  ) {}

  #key(roomId: string, eventId: string, owner = this.owner()): string {
    return `${owner ?? ''}\n${roomId}\n${eventId}`;
  }

  get(roomId: string, eventId: string): TimelineItemView | null | undefined {
    const found = this.#items.get(this.#key(roomId, eventId));
    if (found === undefined) this.#request(roomId, eventId);
    return found;
  }

  put(roomId: string, items: readonly TimelineItemView[]): void {
    for (const item of items) {
      if (item.event_id !== null) this.#items.set(this.#key(roomId, item.event_id), item);
    }
  }

  #request(roomId: string, eventId: string): void {
    let queued = this.#queued.get(roomId);
    if (!queued) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- part of the request queue
      queued = new Set();
      this.#queued.set(roomId, queued);
    }
    queued.add(eventId);
    if (this.#flushing) return;
    this.#flushing = true;
    queueMicrotask(() => {
      this.#flushing = false;
      void this.#flush();
    });
  }

  async #flush(): Promise<void> {
    const batches = [...this.#queued];
    this.#queued.clear();
    const owner = this.owner();
    await Promise.all(
      batches.map(async ([roomId, ids]) => {
        const wanted = [...ids].filter((id) => !this.#items.has(this.#key(roomId, id, owner)));
        if (wanted.length === 0) return;
        for (const id of wanted) this.#items.set(this.#key(roomId, id, owner), null);
        try {
          const items = await this.commands.eventItems(roomId, wanted);
          for (const item of items) {
            if (item.event_id !== null)
              this.#items.set(this.#key(roomId, item.event_id, owner), item);
          }
        } catch (error) {
          console.debug('[sable room] event items unavailable', error);
        }
      })
    );
  }
}

export const [useEventItems, provideEventItems] = createContext<EventItems>();
