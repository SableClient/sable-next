import QuickLRU from 'quick-lru';

import { CoreError } from '#src/transport';

import { runtimeConfig } from '#lib/config/runtime-config.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type { UrlPreviewView } from '#src/generated/protocol';

const previews = new QuickLRU<string, Promise<UrlPreviewView | null>>({ maxSize: 256 });
let homeserverPreviews = true;
const PREVIEW_TIMEOUT_MS = 10_000;

export function resetUrlPreviews(): void {
  previews.clear();
  homeserverPreviews = true;
}

export function loadUrlPreview(
  commands: Pick<CoreCommands, 'urlPreview'>,
  url: string,
  service: string | null
): Promise<UrlPreviewView | null> {
  if (service === null && !homeserverPreviews) return Promise.resolve(null);

  const key = `${service ?? 'homeserver'}:${url}`;
  const cached = previews.get(key);
  if (cached) return cached;

  const request = commands.urlPreview(url, service).catch((error: unknown) => {
    if (service === null && error instanceof CoreError && error.detail.code === 'unsupported') {
      homeserverPreviews = false;
    }
    console.warn('[sable link preview] unavailable', url, error);
    return null;
  });
  const promise = new Promise<UrlPreviewView | null>((resolve) => {
    const timer = setTimeout(() => {
      previews.delete(key);
      console.warn('[sable link preview] timed out', url);
      resolve(null);
    }, PREVIEW_TIMEOUT_MS);
    void request.then((preview) => {
      clearTimeout(timer);
      resolve(preview);
    });
  });
  previews.set(key, promise);
  return promise;
}

export interface PreviewSources {
  server: boolean;
  client: boolean;
}

export function previewSources(encrypted: boolean | null): PreviewSources {
  return {
    server: encrypted === false ? preferences.urlPreviews : preferences.encryptedUrlPreviews,
    client: preferences.clientEmbeds && (encrypted === false || preferences.encryptedClientEmbeds),
  };
}

export async function resolveUrlPreview(
  commands: Pick<CoreCommands, 'urlPreview'>,
  url: string,
  sources: PreviewSources
): Promise<UrlPreviewView | null> {
  const service = sources.client ? (await runtimeConfig()).embeds.serviceUrl : null;
  const fromService = service === null ? null : await loadUrlPreview(commands, url, service);
  if (fromService !== null || !sources.server) return fromService;
  return loadUrlPreview(commands, url, null);
}
