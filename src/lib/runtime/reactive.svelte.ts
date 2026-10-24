import { createSubscriber } from 'svelte/reactivity';

import type { Subscription } from './subscription';

/** The state of a subscription, tracked by whatever reads `current` in an effect or a template. */
export function reactive<S>(subscription: Subscription<S>): { readonly current: S | undefined } {
  const subscribe = createSubscriber((update) => subscription.subscribe(update));
  return {
    get current() {
      subscribe();
      return subscription.get();
    },
  };
}
