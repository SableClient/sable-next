import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';

const DIRECTORY_LIMIT = 10;

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
  // Nothing renders from this; it only stops a term being looked up twice.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #searched = new Set<string>();

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

  async lookup(term: string): Promise<boolean> {
    const folded = term.trim().toLocaleLowerCase();
    if (folded === '' || this.#searched.has(folded)) return false;
    this.#searched.add(folded);

    try {
      const { results } = await this.#core.commands.searchUserDirectory(folded, DIRECTORY_LIMIT);
      const fresh = results.filter((entry) => !this.#identities.has(entry.user_id));
      for (const entry of fresh) {
        this.#identities.set(entry.user_id, {
          userId: entry.user_id,
          displayName: entry.display_name ?? entry.user_id,
          avatarUrl: entry.avatar_url,
        });
      }
      return fresh.length > 0;
    } catch {
      return false;
    }
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
