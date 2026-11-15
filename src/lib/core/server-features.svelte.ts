import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from './client.svelte.js';

const loaded = new SvelteMap<string, readonly string[]>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- read while deriving, so it must not be tracked
const requested = new Set<string>();

/** The homeserver's enabled unstable features, empty until the first read lands. */
export function serverFeatures(core: CoreClient): readonly string[] {
  const account = core.session?.account_id;
  if (!account) return [];
  const flags = loaded.get(account);
  if (flags) return flags;
  if (!requested.has(account)) {
    requested.add(account);
    core.rpc.session.serverFeatures().then(
      (features) => loaded.set(account, features),
      (error: unknown) => {
        requested.delete(account);
        console.debug('[sable] server features unavailable', error);
      }
    );
  }
  return [];
}
