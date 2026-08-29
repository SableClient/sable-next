import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type { UrlPreviewView } from '#src/generated/UrlPreviewView';

const previews = new Map<string, Promise<UrlPreviewView | null>>();

export function loadUrlPreview(
  commands: Pick<CoreCommands, 'urlPreview'>,
  url: string
): Promise<UrlPreviewView | null> {
  const cached = previews.get(url);
  if (cached) return cached;

  const promise = commands.urlPreview(url).catch((error: unknown) => {
    console.warn('[sable link preview] unavailable', url, error);
    return null;
  });
  previews.set(url, promise);
  return promise;
}
