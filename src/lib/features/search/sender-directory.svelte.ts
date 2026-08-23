import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';

export interface SenderIdentity {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export class SenderDirectory {
  #core: CoreClient;
  #identities = new SvelteMap<string, SenderIdentity>();
  // Nothing renders from this; it only stops a second request in flight.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #requested = new Set<string>();

  constructor(core: CoreClient) {
    this.#core = core;
  }

  identity(userId: string): SenderIdentity {
    const known = this.#identities.get(userId);
    if (known) return known;

    this.#request(userId);
    return { userId, displayName: userId, avatarUrl: null };
  }

  known(): SenderIdentity[] {
    return [...this.#identities.values()];
  }

  #request(userId: string): void {
    if (this.#requested.has(userId)) return;
    this.#requested.add(userId);

    void this.#core
      .userProfile(userId)
      .then((profile) => {
        this.#identities.set(userId, {
          userId,
          displayName: profile.display_name ?? userId,
          avatarUrl: profile.avatar_url,
        });
      })
      .catch(() => {
        this.#identities.set(userId, { userId, displayName: userId, avatarUrl: null });
      });
  }
}
