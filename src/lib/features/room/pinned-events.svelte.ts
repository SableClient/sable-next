import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

import type { CoreCommands } from '#lib/core/commands.svelte.js';

export type PinnedEventCommands = Pick<CoreCommands, 'pinnedEvents' | 'setPinned'>;

export class PinnedEvents {
  readonly #ids = new SvelteSet<string>();
  #roomId: string | null = null;
  #generation = 0;

  constructor(private readonly commands: PinnedEventCommands) {}

  has(eventId: string | null | undefined): boolean {
    return eventId !== null && eventId !== undefined && this.#ids.has(eventId);
  }

  async load(roomId: string): Promise<void> {
    const generation = ++this.#generation;
    if (this.#roomId !== roomId) {
      this.#roomId = roomId;
      this.#ids.clear();
    }

    try {
      const ids = await this.commands.pinnedEvents(roomId);
      if (generation !== this.#generation) return;
      this.#replace(ids);
    } catch (error) {
      console.warn('[sable timeline] pinned events unavailable', error);
    }
  }

  async toggle(roomId: string, eventId: string): Promise<void> {
    const generation = ++this.#generation;
    const ids = await this.commands.setPinned(roomId, eventId, !this.has(eventId));
    if (generation !== this.#generation || this.#roomId !== roomId) return;
    this.#replace(ids);
  }

  #replace(ids: readonly string[]): void {
    this.#ids.clear();
    for (const id of ids) this.#ids.add(id);
  }
}

export const [usePinnedEvents, providePinnedEvents] = createContext<PinnedEvents>();
