import { createContext } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';

import { PinnedEvents } from './pinned-events.svelte.js';

export interface RoomScope {
  cosmetics: RoomCosmetics;
  pinned: PinnedEvents;
}

export class RoomScopes {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a cache nothing renders from
  readonly #rooms = new Map<string, RoomScope>();

  constructor(private readonly core: CoreClient) {}

  for(roomId: string): RoomScope {
    const key = `${this.core.session?.user_id ?? ''}\n${roomId}`;
    const found = this.#rooms.get(key);
    if (found) return found;
    const scope = {
      cosmetics: new RoomCosmetics(this.core),
      pinned: new PinnedEvents(this.core.commands),
    };
    this.#rooms.set(key, scope);
    scope.cosmetics.watch();
    void scope.cosmetics.load(roomId, null);
    return scope;
  }
}

export const [useRoomScopes, provideRoomScopes] = createContext<RoomScopes>();
