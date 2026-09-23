import { untrack } from 'svelte';

export function untrackFetch(target: { fetch: typeof fetch }): void {
  const tracked = target.fetch;
  target.fetch = (...args: Parameters<typeof fetch>) => untrack(() => tracked(...args));
}
