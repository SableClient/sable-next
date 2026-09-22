import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';

export interface AccountIdentity {
  displayName: string;
  avatarUrl: string | null;
}

export class AccountDirectory {
  #core: CoreClient;
  #accountId: string | null = null;
  #identities = new SvelteMap<string, AccountIdentity>();
  // Nothing renders from this; it only stops a second request in flight.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #requested = new Set<string>();

  constructor(core: CoreClient) {
    this.#core = core;
  }

  identity(userId: string): AccountIdentity {
    const accountId = this.#core.session?.account_id ?? null;
    if (accountId !== this.#accountId) {
      // Profiles are fetched through the active session; start over on switch.
      this.#accountId = accountId;
      this.#identities.clear();
      this.#requested.clear();
    }

    const known = this.#identities.get(userId);
    if (known) return known;

    this.#request(userId);
    return { displayName: userId, avatarUrl: null };
  }

  #request(userId: string): void {
    if (this.#requested.has(userId)) return;
    this.#requested.add(userId);

    void this.#core
      .userProfile(userId)
      .then((profile) => {
        this.#identities.set(userId, {
          displayName: profile.display_name ?? userId,
          avatarUrl: profile.avatar_url,
        });
      })
      .catch(() => {
        // Let a later render retry; the core throttles repeat failures.
        this.#requested.delete(userId);
      });
  }
}
