import { SvelteMap } from 'svelte/reactivity';

import type { CoreClient } from '$lib/core/client.svelte';

const objectUrls = new SvelteMap<string, string>();
const pending = new SvelteMap<string, Promise<string>>();

function cacheKey(source: string, width: number, height: number): string {
  return `${source}:${String(width)}:${String(height)}`;
}

/** Lets a caller paint a known source without waiting a frame for a microtask. */
export function cachedMediaUrl(source: string, width: number, height: number): string | undefined {
  return objectUrls.get(cacheKey(source, width, height));
}

/**
 * Media needs the access token, which never leaves the core, so the bytes come
 * back through a command and get wrapped in an object URL. One URL per source
 * and size, shared by every message referencing it.
 */
export function loadMediaUrl(
  core: Pick<CoreClient, 'fetchMedia'>,
  source: string,
  width: number,
  height: number,
  mime?: string | null
): Promise<string> {
  const key = cacheKey(source, width, height);
  const request =
    pending.get(key) ??
    core.fetchMedia(source, width, height).then((bytes) => {
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime ?? '' }));
      objectUrls.set(key, objectUrl);
      pending.delete(key);
      return objectUrl;
    });
  pending.set(key, request);
  return request;
}
