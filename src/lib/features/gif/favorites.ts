import { isAllowedGifMediaUrl, type GifResult } from './providers';

const storageKey = 'sable.composer.favoriteGifs';
const limit = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/* Re-checked: anything on the origin can write this store. */
function parse(entry: unknown): GifResult | undefined {
  if (!isRecord(entry) || typeof entry.mediaUrl !== 'string') return undefined;
  if (!isAllowedGifMediaUrl(entry.mediaUrl)) return undefined;

  const previewUrl =
    typeof entry.previewUrl === 'string' && isAllowedGifMediaUrl(entry.previewUrl)
      ? entry.previewUrl
      : entry.mediaUrl;

  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    title: typeof entry.title === 'string' ? entry.title : 'GIF',
    mediaUrl: entry.mediaUrl,
    previewUrl,
    width: count(entry.width),
    height: count(entry.height),
    size: count(entry.size),
    mimetype: typeof entry.mimetype === 'string' ? entry.mimetype : 'image/gif',
  };
}

export function readFavorites(): GifResult[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(parse).filter((gif): gif is GifResult => gif !== undefined);
  } catch {
    return [];
  }
}

function write(gifs: readonly GifResult[]): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(storageKey, JSON.stringify(gifs));
  } catch {
    /* A full store costs the list, not the picker. */
  }
}

export function isFavorite(gifs: readonly GifResult[], gif: GifResult): boolean {
  return gifs.some((entry) => entry.mediaUrl === gif.mediaUrl);
}

export function toggleFavorite(gifs: readonly GifResult[], gif: GifResult): GifResult[] {
  const without = gifs.filter((entry) => entry.mediaUrl !== gif.mediaUrl);
  const next = without.length === gifs.length ? [gif, ...without].slice(0, limit) : without;
  write(next);
  return next;
}
