import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { senderName } from './inbox';

export class DisplayNames {
  readonly #names = new SvelteMap<string, string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only guards duplicate requests
  readonly #requested = new Set<string>();

  constructor(private readonly core: Pick<CoreClient, 'userProfile'>) {}

  name(userId: string): string {
    if (!this.#requested.has(userId)) {
      this.#requested.add(userId);
      void this.core.userProfile(userId).then(
        (profile) => {
          if (profile.display_name) this.#names.set(userId, profile.display_name);
        },
        () => undefined
      );
    }
    return this.#names.get(userId) ?? senderName(userId);
  }
}
