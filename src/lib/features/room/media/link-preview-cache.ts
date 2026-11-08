import QuickLRU from 'quick-lru';

import { CoreError } from '#src/transport';

import { runtimeConfig } from '#lib/config/runtime-config.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { UrlPreviewView, Rpc } from '#src/generated/protocol';

const previews = new QuickLRU<string, Promise<UrlPreviewView | null>>({ maxSize: 256 });
let homeserverPreviews = true;
const PREVIEW_TIMEOUT_MS = 10_000;

export function resetUrlPreviews(): void {
  previews.clear();
  homeserverPreviews = true;
}

export function loadUrlPreview(
  messages: Pick<Rpc['messages'], 'urlPreview'>,
  url: string,
  client: boolean,
  service: string | null = null
): Promise<UrlPreviewView | null> {
  if (!client && !homeserverPreviews) return Promise.resolve(null);

  const key = client ? `client:${service ?? ''}:${url}` : `homeserver:${url}`;
  const cached = previews.get(key);
  if (cached) return cached;

  const params = client ? { url, client, service } : { url, service: null };
  const request = messages.urlPreview(params).catch((error: unknown) => {
    if (!client && error instanceof CoreError && error.detail.code === 'unsupported') {
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
  messages: Pick<Rpc['messages'], 'urlPreview'>,
  url: string,
  sources: PreviewSources
): Promise<UrlPreviewView | null> {
  const fromClient = sources.client
    ? await loadUrlPreview(messages, url, true, (await runtimeConfig()).embeds.serviceUrl)
    : null;
  if (fromClient !== null || !sources.server) return fromClient;
  return loadUrlPreview(messages, url, false);
}
