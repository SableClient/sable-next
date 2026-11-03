import type { CoreClient } from '#lib/core/client.svelte.js';

import { defaultE2eePolicy, type E2eePolicy } from './e2ee-policy.js';

export function loadE2eePolicy(core: Pick<CoreClient, 'e2eePolicy'>): {
  readonly current: E2eePolicy;
} {
  let current = $state(defaultE2eePolicy);
  void core.e2eePolicy().then((loaded) => (current = loaded));
  return {
    get current() {
      return current;
    },
  };
}
