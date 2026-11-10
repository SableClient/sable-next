import QuickLRU from 'quick-lru';

import { CoreError } from '#src/transport';
import { mediaFailureHold } from '#lib/ui/media-retry.js';
import { imageMime, mediaMime } from '#lib/media-signatures.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { CoreMedia } from '#lib/core/media.svelte.js';

/* Not `SvelteMap`: callers read the cache from inside an effect, so a reactive
   miss re-runs every waiting media element each time any other one resolves. */
type CachedMediaUrl = {
  url: string;
  bytes: number;
  ratio: number | undefined;
  type: string;
  animated: boolean;
};

const objectUrls = new Map<string, CachedMediaUrl>();
const pending = new Map<string, Promise<string>>();
const holds = new Map<string, number>();
const displaced = new Map<string, string[]>();
const MAX_OBJECT_URLS = 512;
const MAX_OBJECT_URL_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_METADATA = 512;
const ANIMATION_HEADER_BYTES = 65536;
const MEDIA_FAILURE_MEMORY_MS = 30 * 60_000;
/* Failures expire at `until`; `Unavailable` covers a blip as well as a 404. */
const failures = new QuickLRU<string, { count: number; until: number }>({
  maxSize: MAX_MEDIA_METADATA,
  maxAge: MEDIA_FAILURE_MEMORY_MS,
});
/* Not cleared by a retry: the core already knows the server is failing. */
const refused = new QuickLRU<string, number>({ maxSize: MAX_MEDIA_METADATA });
const missing = new QuickLRU<string, true>({
  maxSize: MAX_MEDIA_METADATA,
  maxAge: MEDIA_FAILURE_MEMORY_MS,
});
const displayFailures = new QuickLRU<string, number>({ maxSize: MAX_MEDIA_METADATA });
const DISPLAY_RECOVERY_STEPS = 2;
const aspectRatios = new QuickLRU<string, number>({ maxSize: MAX_MEDIA_METADATA });
let objectUrlBytes = 0;
let evictQueued = false;

function recordFailure(key: string): void {
  const count = (failures.get(key)?.count ?? 0) + 1;
  failures.set(key, { count, until: Date.now() + mediaFailureHold(count) });
}

function isHeld(key: string): boolean {
  const failure = failures.get(key);
  return failure !== undefined && Date.now() < failure.until;
}

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

export { imageMime } from '#lib/media-signatures.js';

export function isAnimatedImage(bytes: Uint8Array): boolean {
  const type = imageMime(bytes);
  if (type === 'image/gif') return true;
  const head = new TextDecoder('latin1').decode(bytes);
  if (type === 'image/png') {
    const frames = head.indexOf('acTL');
    return frames !== -1 && (head.indexOf('IDAT') === -1 || frames < head.indexOf('IDAT'));
  }
  return type === 'image/webp' && head.startsWith('VP8X', 12) && (bytes[20] & 0x02) !== 0;
}

function blobType(mime: string | null | undefined, bytes: Uint8Array): string {
  if (mime && mime !== 'application/octet-stream') return mime;
  return mediaMime(bytes) ?? '';
}

function measure(key: string, type: string, blob: Blob): Promise<void> | null {
  // An empty type is a sniffer miss: encrypted attachments often carry no mime.
  const worthDecoding = type === '' || type.startsWith('image/');
  if (!worthDecoding || aspectRatios.has(key) || typeof createImageBitmap !== 'function') {
    return null;
  }
  return createImageBitmap(blob, { imageOrientation: 'from-image' })
    .then((bitmap) => {
      if (bitmap.width > 0 && bitmap.height > 0) {
        aspectRatios.set(key, bitmap.width / bitmap.height);
      }
      bitmap.close();
    })
    .catch((error: unknown) => {
      console.debug('[sable media] the aspect ratio could not be measured', error);
    });
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

export function cachedMediaAnimated(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number
): boolean | undefined {
  return objectUrls.get(cacheKey(core.session?.account_id, source, width, height))?.animated;
}

export function cachedMediaType(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number
): string | undefined {
  return objectUrls.get(cacheKey(core.session?.account_id, source, width, height))?.type;
}

export function discardMediaUrl(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number,
  url: string
): void {
  const key = cacheKey(core.session?.account_id, source, width, height);
  if (dropObjectUrl(key, url)) recordFailure(key);
}

function dropObjectUrl(key: string, url: string): boolean {
  const cached = objectUrls.get(key);
  if (cached?.url !== url) return false;
  URL.revokeObjectURL(cached.url);
  objectUrls.delete(key);
  objectUrlBytes -= cached.bytes;
  return true;
}

export function mediaUrlShown(
  core: Pick<CoreClient, 'session'>,
  source: string,
  width: number,
  height: number
): void {
  displayFailures.delete(cacheKey(core.session?.account_id, source, width, height));
}

export function recoverMediaUrl(
  core: MediaFetcher & { media: Pick<CoreMedia, 'forgetMedia'> },
  source: string,
  width: number,
  height: number,
  url: string,
  mime?: string | null
): Promise<string> | null {
  const key = cacheKey(core.session?.account_id, source, width, height);
  const current = objectUrls.get(key)?.url;
  if (current !== undefined && current !== url) return Promise.resolve(current);
  const joined = pending.get(key);
  if (joined !== undefined) return joined;
  const step = displayFailures.get(key) ?? 0;
  if (step >= DISPLAY_RECOVERY_STEPS) return null;
  displayFailures.set(key, step + 1);
  dropObjectUrl(key, url);
  if (step === 0) return loadMediaUrl(core, source, width, height, mime);
  const request = core.media
    .forgetMedia(source)
    .then(() => {
      pending.delete(key);
      return loadMediaUrl(core, source, width, height, mime);
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
  pending.set(key, request);
  return request;
}

/**
 * Fetches media through a command, since the access token stays in the core, and wraps it in an object URL shared per source and size.
 */
export type MediaFetcher = Pick<CoreClient, 'session'> & {
  media: Pick<CoreMedia, 'fetchMedia'>;
};

export function loadMediaUrl(
  core: MediaFetcher,
  source: string,
  width: number,
  height: number,
  mime?: string | null
): Promise<string> {
  const key = cacheKey(core.session?.account_id, source, width, height);
  if (missing.has(key)) return Promise.reject(new CoreError({ code: 'media_not_found' }));
  const refusedUntil = refused.get(key);
  if (refusedUntil !== undefined) {
    return Promise.reject(
      new CoreError({
        code: 'media_server_unavailable',
        retry_after_ms: Math.max(0, refusedUntil - Date.now()),
      })
    );
  }
  if (isHeld(key)) return Promise.reject(new Error('Media unavailable'));
  const joined = pending.get(key);
  if (joined !== undefined) return joined;
  const request = core.media
    .fetchMedia(source, width, height)
    .then((bytes) => {
      const type = blobType(mime, bytes);
      const blob = new Blob([bytes], { type });
      const publish = (): string => {
        const objectUrl = URL.createObjectURL(blob);
        const previous = objectUrls.get(key);
        if (previous !== undefined) {
          objectUrlBytes -= previous.bytes;
          if (holds.has(key)) displaced.set(key, [...(displaced.get(key) ?? []), previous.url]);
          else URL.revokeObjectURL(previous.url);
        }
        objectUrls.set(key, {
          url: objectUrl,
          bytes: blob.size,
          ratio: aspectRatios.get(key),
          type,
          animated: isAnimatedImage(bytes.subarray(0, ANIMATION_HEADER_BYTES)),
        });
        objectUrlBytes += blob.size;
        failures.delete(key);
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
      refused.set(key, Date.now() + error.detail.retry_after_ms, {
        maxAge: error.detail.retry_after_ms,
      });
      return;
    }
    if (error instanceof CoreError && error.detail.code === 'media_not_found') {
      missing.set(key, true);
      return;
    }
    recordFailure(key);
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
  for (const key of [...failures.keys()]) {
    if (key.startsWith(prefix)) failures.delete(key);
  }
  for (const key of [...missing.keys()]) {
    if (key.startsWith(prefix)) missing.delete(key);
  }
  for (const key of [...displayFailures.keys()]) {
    if (key.startsWith(prefix)) displayFailures.delete(key);
  }
  return loadMediaUrl(core, source, width, height, mime);
}
