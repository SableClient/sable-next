import { createContext } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';

import { PinnedEvents } from '../timeline/pinned-events.svelte.js';

export interface RoomScope {
  cosmetics: RoomCosmetics;
  pinned: PinnedEvents;
}

type ScopeCore = Pick<CoreClient, 'session' | 'subscribeEvents'> & {
  commands: Pick<CoreClient['commands'], 'roomCosmetics' | 'pinnedEvents' | 'setPinned'>;
};

type Entry = { scope: RoomScope; consumers: number; stop: () => void };

export class RoomScopes {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a cache nothing renders from
  readonly #rooms = new Map<string, Entry>();

  constructor(private readonly core: ScopeCore) {}

  acquire(roomId: string): RoomScope & { release: () => void } {
    const key = `${this.core.session?.account_id ?? ''}\n${roomId}`;
    let entry = this.#rooms.get(key);
    if (!entry) {
      const scope = {
        cosmetics: new RoomCosmetics(this.core),
        pinned: new PinnedEvents(this.core.commands),
      };
      entry = { scope, consumers: 0, stop: scope.cosmetics.watch() };
      this.#rooms.set(key, entry);
      void scope.cosmetics.load(roomId, null);
    }
    const held = entry;
    held.consumers += 1;
    let released = false;
    return {
      ...held.scope,
      release: () => {
        if (released || this.#rooms.get(key) !== held) return;
        released = true;
        held.consumers -= 1;
        if (held.consumers === 0) {
          held.stop();
          this.#rooms.delete(key);
        }
      },
    };
  }

  dispose(): void {
    for (const entry of this.#rooms.values()) entry.stop();
    this.#rooms.clear();
  }
}

export const [useRoomScopes, provideRoomScopes] = createContext<RoomScopes>();
