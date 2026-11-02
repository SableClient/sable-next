import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { senderName } from './inbox';

const MAX_ATTEMPTS = 3;

export class DisplayNames {
  readonly #names = new SvelteMap<string, string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only guards duplicate requests
  readonly #requested = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only counts failed requests
  readonly #failures = new Map<string, number>();

  constructor(private readonly core: Pick<CoreClient, 'userProfile'>) {}

  forget = (userId: string): void => {
    this.#requested.delete(userId);
    this.#names.delete(userId);
  };

  name(userId: string): string {
    if (!this.#requested.has(userId)) {
      this.#requested.add(userId);
      void this.core.userProfile(userId).then(
        (profile) => {
          if (profile.display_name) this.#names.set(userId, profile.display_name);
        },
        (error: unknown) => {
          console.debug('[sable inbox] display name unavailable', error);
          const failures = (this.#failures.get(userId) ?? 0) + 1;
          this.#failures.set(userId, failures);
          if (failures < MAX_ATTEMPTS) this.#requested.delete(userId);
        }
      );
    }
    return this.#names.get(userId) ?? senderName(userId);
  }
}
