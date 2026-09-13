import { CoreError } from '#src/transport';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type { UrlPreviewView } from '#src/generated/protocol';

const previews = new Map<string, Promise<UrlPreviewView | null>>();
let homeserverPreviews = true;

export function resetUrlPreviews(): void {
  previews.clear();
  homeserverPreviews = true;
}

export function loadUrlPreview(
  commands: Pick<CoreCommands, 'urlPreview'>,
  url: string
): Promise<UrlPreviewView | null> {
  if (!homeserverPreviews) return Promise.resolve(null);

  const cached = previews.get(url);
  if (cached) return cached;

  const promise = commands.urlPreview(url).catch((error: unknown) => {
    if (error instanceof CoreError && error.detail.code === 'unsupported') {
      homeserverPreviews = false;
    }
    console.warn('[sable link preview] unavailable', url, error);
    return null;
  });
  previews.set(url, promise);
  return promise;
}
