import type { CoreClient } from '#lib/core/client.svelte.js';

/* Not `SvelteMap`: callers read the cache from inside an effect, so a reactive
   miss re-runs every waiting media element each time any other one resolves. */
const objectUrls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const aspectRatios = new Map<string, number>();
/* An object URL pins its blob until revoked. Far more than one viewport holds,
   so the least recently read entry is never one on screen. */
const MAX_OBJECT_URLS = 256;

function cacheKey(source: string, width: number, height: number): string {
  return `${source}:${String(width)}:${String(height)}`;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function imageMime(bytes: Uint8Array): string | undefined {
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

function measure(source: string, type: string, blob: Blob): Promise<void> | null {
  // An empty type is a sniffer miss: encrypted attachments often carry no mime.
  const worthDecoding = type === '' || type.startsWith('image/');
  if (!worthDecoding || aspectRatios.has(source) || typeof createImageBitmap !== 'function') {
    return null;
  }
  return createImageBitmap(blob)
    .then((bitmap) => {
      if (bitmap.width > 0 && bitmap.height > 0) {
        aspectRatios.set(source, bitmap.width / bitmap.height);
      }
      bitmap.close();
    })
    .catch(() => {});
}

export function mediaAspectRatio(source: string): number | null {
  return aspectRatios.get(source) ?? null;
}

/** Lets a caller paint a known source without waiting a frame for a microtask. */
export function cachedMediaUrl(source: string, width: number, height: number): string | undefined {
  const key = cacheKey(source, width, height);
  const objectUrl = objectUrls.get(key);
  if (objectUrl === undefined) return undefined;
  // Re-inserted so the map's own order is the eviction order.
  objectUrls.delete(key);
  objectUrls.set(key, objectUrl);
  return objectUrl;
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
    core
      .fetchMedia(source, width, height)
      .then((bytes) => {
        const type = mime ?? imageMime(bytes) ?? '';
        const blob = new Blob([bytes], { type });
        const publish = (): string => {
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.set(key, objectUrl);
          for (const [oldestKey, oldestUrl] of objectUrls) {
            if (objectUrls.size <= MAX_OBJECT_URLS) break;
            URL.revokeObjectURL(oldestUrl);
            objectUrls.delete(oldestKey);
          }
          return objectUrl;
        };
        const measuring = measure(source, type, blob);
        return measuring === null ? publish() : measuring.then(publish);
      })
      .finally(() => {
        pending.delete(key);
      });
  pending.set(key, request);
  return request;
}
