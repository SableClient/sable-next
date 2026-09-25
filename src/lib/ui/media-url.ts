import type { CoreClient } from '#lib/core/client.svelte.js';
import type { CoreCommands } from '#lib/core/commands.svelte.js';

/* Not `SvelteMap`: callers read the cache from inside an effect, so a reactive
   miss re-runs every waiting media element each time any other one resolves. */
type CachedMediaUrl = { url: string; bytes: number; ratio: number | undefined };

const objectUrls = new Map<string, CachedMediaUrl>();
const pending = new Map<string, Promise<string>>();
/* A deadline, not a verdict: `Unavailable` covers a blip as well as a 404. */
const unavailable = new Map<string, number>();
const aspectRatios = new Map<string, number>();
const holds = new Map<string, number>();
/* An object URL pins its blob until revoked. Held entries are exempt. */
const MAX_OBJECT_URLS = 64;
const MAX_OBJECT_URL_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_METADATA = 512;
const MAX_MEDIA_REQUESTS = 6;
const MEDIA_STALL_TIMEOUT_MS = 30_000;
const MEDIA_FAILURE_TTL_MS = 30_000;
let objectUrlBytes = 0;
let inflight = 0;
const waiting: (() => void)[] = [];

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else inflight -= 1;
}

function markUnavailable(key: string): void {
  unavailable.set(key, Date.now() + MEDIA_FAILURE_TTL_MS);
  if (unavailable.size > MAX_MEDIA_METADATA) {
    const oldest = unavailable.keys().next().value;
    if (oldest !== undefined) unavailable.delete(oldest);
  }
}

function cacheKey(
  accountId: string | undefined,
  source: string,
  width: number,
  height: number
): string {
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
        if (aspectRatios.size > MAX_MEDIA_METADATA) {
          const oldest = aspectRatios.keys().next().value;
          if (oldest !== undefined) aspectRatios.delete(oldest);
        }
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

function evict(published: string): void {
  for (const [oldestKey, oldest] of objectUrls) {
    if (objectUrls.size <= MAX_OBJECT_URLS && objectUrlBytes <= MAX_OBJECT_URL_BYTES) break;
    if (oldestKey === published || holds.has(oldestKey)) continue;
    URL.revokeObjectURL(oldest.url);
    objectUrls.delete(oldestKey);
    objectUrlBytes -= oldest.bytes;
  }
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
    if (remaining > 0) holds.set(key, remaining);
    else holds.delete(key);
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
  markUnavailable(key);
}

/**
 * Media needs the access token, which never leaves the core, so the bytes come
 * back through a command and get wrapped in an object URL. One URL per source
 * and size, shared by every message referencing it.
 */
export type MediaFetcher = Pick<CoreClient, 'session' | 'subscribeEvents'> & {
  commands: Pick<CoreCommands, 'fetchMedia'>;
};

function fetchThroughGate(
  core: MediaFetcher,
  source: string,
  width: number,
  height: number
): Promise<Uint8Array<ArrayBuffer>> {
  const fetch = (): Promise<Uint8Array<ArrayBuffer>> =>
    core.commands.fetchMedia(source, width, height);
  const withinDeadline = (
    request: Promise<Uint8Array<ArrayBuffer>>
  ): Promise<Uint8Array<ArrayBuffer>> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => {};
    const stalled = new Promise<Uint8Array<ArrayBuffer>>((_, reject) => {
      const arm = (): void => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          reject(new Error('Media request stalled'));
        }, MEDIA_STALL_TIMEOUT_MS);
      };
      arm();
      unsubscribe = core.subscribeEvents((event) => {
        if (event.type === 'media_progress' && event.source === source) arm();
      });
    });
    return Promise.race([request, stalled]).finally(() => {
      clearTimeout(timeout);
      unsubscribe();
    });
  };
  const guardedFetch = (): Promise<Uint8Array<ArrayBuffer>> => {
    return withinDeadline(fetch());
  };
  if (inflight < MAX_MEDIA_REQUESTS) {
    inflight += 1;
    return guardedFetch();
  }
  return new Promise<void>((resolve) => waiting.push(resolve)).then(guardedFetch);
}

export function loadMediaUrl(
  core: MediaFetcher,
  source: string,
  width: number,
  height: number,
  mime?: string | null
): Promise<string> {
  const key = cacheKey(core.session?.account_id, source, width, height);
  const failedUntil = unavailable.get(key);
  if (failedUntil !== undefined) {
    if (Date.now() < failedUntil) return Promise.reject(new Error('Media unavailable'));
    unavailable.delete(key);
  }
  const request =
    pending.get(key) ??
    fetchThroughGate(core, source, width, height)
      .then((bytes) => {
        const type = mime ?? imageMime(bytes) ?? '';
        const blob = new Blob([bytes], { type });
        const publish = (): string => {
          const objectUrl = URL.createObjectURL(blob);
          const previous = objectUrls.get(key);
          if (previous !== undefined) {
            objectUrlBytes -= previous.bytes;
            if (!holds.has(key)) URL.revokeObjectURL(previous.url);
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
        releaseSlot();
      });
  pending.set(key, request);
  void request.catch(() => {
    markUnavailable(key);
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
  for (const key of unavailable.keys()) {
    if (key.startsWith(prefix)) unavailable.delete(key);
  }
  return loadMediaUrl(core, source, width, height, mime);
}
