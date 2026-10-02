import QuickLRU from 'quick-lru';

import { CoreError } from '#src/transport';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { CoreCommands } from '#lib/core/commands.svelte.js';

/* Not `SvelteMap`: callers read the cache from inside an effect, so a reactive
   miss re-runs every waiting media element each time any other one resolves. */
type CachedMediaUrl = { url: string; bytes: number; ratio: number | undefined };

const objectUrls = new Map<string, CachedMediaUrl>();
const pending = new Map<string, Promise<string>>();
const holds = new Map<string, number>();
const displaced = new Map<string, string[]>();
const MAX_OBJECT_URLS = 512;
const MAX_OBJECT_URL_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_METADATA = 512;
const MEDIA_FAILURE_TTL_MS = 30_000;
/* A deadline, not a verdict: `Unavailable` covers a blip as well as a 404. */
const unavailable = new QuickLRU<string, true>({
  maxSize: MAX_MEDIA_METADATA,
  maxAge: MEDIA_FAILURE_TTL_MS,
});
/* Not cleared by a retry: the core already knows the server is failing. */
const refused = new QuickLRU<string, true>({ maxSize: MAX_MEDIA_METADATA });
const aspectRatios = new QuickLRU<string, number>({ maxSize: MAX_MEDIA_METADATA });
let objectUrlBytes = 0;
let evictQueued = false;

function cacheKey(
  accountId: string | undefined,
  source: string,
  width: number,
  height: number
): string {
  if (isEncryptedMedia(source) || width === 0 || height === 0) {
    width = 0;
    height = 0;
  }
  return `${accountId ?? ''}:${source}:${String(width)}:${String(height)}`;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export function imageMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp';

  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return undefined;
}

function measure(key: string, type: string, blob: Blob): Promise<void> | null {
  // An empty type is a sniffer miss: encrypted attachments often carry no mime.
  const worthDecoding = type === '' || type.startsWith('image/');
  if (!worthDecoding || aspectRatios.has(key) || typeof createImageBitmap !== 'function') {
    return null;
  }
  return createImageBitmap(blob)
    .then((bitmap) => {
      if (bitmap.width > 0 && bitmap.height > 0) {
        aspectRatios.set(key, bitmap.width / bitmap.height);
      }
      bitmap.close();
    })
    .catch(() => {});
}

export function mediaAspectRatio(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number
): number | null {
  const key = cacheKey(core.session?.account_id, source, width, height);
  return objectUrls.get(key)?.ratio ?? aspectRatios.get(key) ?? null;
}

function evict(published?: string): void {
  for (const [oldestKey, oldest] of objectUrls) {
    if (objectUrls.size <= MAX_OBJECT_URLS && objectUrlBytes <= MAX_OBJECT_URL_BYTES) break;
    if (oldestKey === published || holds.has(oldestKey)) continue;
    URL.revokeObjectURL(oldest.url);
    objectUrls.delete(oldestKey);
    objectUrlBytes -= oldest.bytes;
  }
}

function evictSoon(): void {
  if (evictQueued) return;
  evictQueued = true;
  queueMicrotask(() => {
    evictQueued = false;
    evict();
  });
}

export function holdMediaUrl(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number
): () => void {
  const key = cacheKey(core.session?.account_id, source, width, height);
  holds.set(key, (holds.get(key) ?? 0) + 1);
  const cached = objectUrls.get(key);
  if (cached !== undefined) {
    // Re-inserted so the map's own order is the eviction order.
    objectUrls.delete(key);
    objectUrls.set(key, cached);
  }
  return () => {
    const remaining = (holds.get(key) ?? 1) - 1;
    if (remaining > 0) {
      holds.set(key, remaining);
      return;
    }
    holds.delete(key);
    for (const url of displaced.get(key) ?? []) URL.revokeObjectURL(url);
    displaced.delete(key);
    evictSoon();
  };
}

export function isEncryptedMedia(source: string): boolean {
  return source.startsWith('{');
}

/** Lets a caller paint a known source without waiting a frame for a microtask. */
export function cachedMediaUrl(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number
): string | undefined {
  return objectUrls.get(cacheKey(core.session?.account_id, source, width, height))?.url;
}

export function discardMediaUrl(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number,
  url: string
): void {
  const key = cacheKey(core.session?.account_id, source, width, height);
  const cached = objectUrls.get(key);
  if (cached?.url !== url) return;
  URL.revokeObjectURL(cached.url);
  objectUrls.delete(key);
  objectUrlBytes -= cached.bytes;
  unavailable.set(key, true);
}

/**
 * Media needs the access token, which never leaves the core, so the bytes come
 * back through a command and get wrapped in an object URL. One URL per source
 * and size, shared by every message referencing it.
 */
export type MediaFetcher = Pick<CoreClient, 'session'> & {
  commands: Pick<CoreCommands, 'fetchMedia'>;
};

export function loadMediaUrl(
  core: MediaFetcher,
  source: string,
  width: number,
  height: number,
  mime?: string | null
): Promise<string> {
  const key = cacheKey(core.session?.account_id, source, width, height);
  if (unavailable.has(key) || refused.has(key)) {
    return Promise.reject(new Error('Media unavailable'));
  }
  const request =
    pending.get(key) ??
    core.commands
      .fetchMedia(source, width, height)
      .then((bytes) => {
        const type = mime ?? imageMime(bytes) ?? '';
        const blob = new Blob([bytes], { type });
        const publish = (): string => {
          const objectUrl = URL.createObjectURL(blob);
          const previous = objectUrls.get(key);
          if (previous !== undefined) {
            objectUrlBytes -= previous.bytes;
            if (holds.has(key)) displaced.set(key, [...(displaced.get(key) ?? []), previous.url]);
            else URL.revokeObjectURL(previous.url);
          }
          objectUrls.set(key, { url: objectUrl, bytes: blob.size, ratio: aspectRatios.get(key) });
          objectUrlBytes += blob.size;
          evict(key);
          return objectUrl;
        };
        const measuring = measure(key, type, blob);
        return measuring === null ? publish() : measuring.then(publish);
      })
      .finally(() => {
        pending.delete(key);
      });
  pending.set(key, request);
  void request.catch((error: unknown) => {
    if (error instanceof CoreError && error.detail.code === 'media_server_unavailable') {
      refused.set(key, true, { maxAge: error.detail.retry_after_ms });
      return;
    }
    unavailable.set(key, true);
  });
  return request;
}

export function retryMediaUrl(
  core: MediaFetcher,
  source: string,
  width: number,
  height: number,
  mime?: string | null
): Promise<string> {
  const prefix = `${core.session?.account_id ?? ''}:${source}:`;
  for (const key of [...unavailable.keys()]) {
    if (key.startsWith(prefix)) unavailable.delete(key);
  }
  return loadMediaUrl(core, source, width, height, mime);
}
