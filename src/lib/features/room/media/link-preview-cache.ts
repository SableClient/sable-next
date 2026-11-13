import QuickLRU from 'quick-lru';

import { isCoreError } from '#src/transport';

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
  service: string | null = null,
  tunnel = false
): Promise<UrlPreviewView | null> {
  if (!client && !homeserverPreviews) return Promise.resolve(null);

  const key = client
    ? `${tunnel ? 'tunnel' : 'client'}:${service ?? ''}:${url}`
    : `homeserver:${url}`;
  const cached = previews.get(key);
  if (cached) return cached;

  const params = client
    ? { url, client, service, ...(tunnel ? { tunnel } : {}) }
    : { url, service: null };
  const request = messages.urlPreview(params).catch((error: unknown) => {
    if (!client && isCoreError(error, 'unsupported')) {
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

const BOT_CHALLENGED_HOSTS = new Set(['klipy.com', 'www.klipy.com']);

function homeserverCanPreview(url: string): boolean {
  try {
    return !BOT_CHALLENGED_HOSTS.has(new URL(url).hostname);
  } catch {
    return true;
  }
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

/** Only a public room that is not encrypted lets the preview service see the whole link. */
export function usesTunnel(encrypted: boolean | null, publicRoom: boolean): boolean {
  return encrypted !== false || !publicRoom;
}

export async function resolveUrlPreview(
  messages: Pick<Rpc['messages'], 'urlPreview'>,
  url: string,
  sources: PreviewSources,
  tunnel = false
): Promise<UrlPreviewView | null> {
  const config = sources.client ? await runtimeConfig() : null;
  const fromClient = config
    ? await loadUrlPreview(messages, url, true, config.embeds.serviceUrl, tunnel)
    : null;
  if (fromClient !== null || !sources.server || !homeserverCanPreview(url)) return fromClient;
  return loadUrlPreview(messages, url, false);
}

export async function scrapedPostVideo(
  messages: Pick<Rpc['messages'], 'urlPreview'>,
  url: string,
  quote: boolean,
  index: number,
  tunnel: boolean
): Promise<string | null> {
  const config = await runtimeConfig();
  const preview = await loadUrlPreview(messages, url, true, config.embeds.serviceUrl, tunnel);
  const post = quote ? preview?.post?.quote : preview?.post;
  const videos = post?.media.filter((media) => media.kind !== 'image') ?? [];
  return videos[index]?.source ?? null;
}
