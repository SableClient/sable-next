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

export function parseFavorites(value: unknown): GifResult[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((gif): gif is GifResult => gif !== undefined);
}

function load(): GifResult[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    return parseFavorites(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
  } catch {
    return [];
  }
}

const state = $state<{ gifs: GifResult[] }>({ gifs: load() });

export function favoriteGifs(): GifResult[] {
  return state.gifs;
}

export function isFavorite(gifs: readonly GifResult[], gif: GifResult): boolean {
  return gifs.some((entry) => entry.mediaUrl === gif.mediaUrl);
}

export function toggleFavorite(gif: GifResult): void {
  const without = state.gifs.filter((entry) => entry.mediaUrl !== gif.mediaUrl);
  write(without.length === state.gifs.length ? [gif, ...without] : without);
}

export function adoptFavorites(gifs: readonly GifResult[]): void {
  write(gifs);
}

function write(gifs: readonly GifResult[]): void {
  state.gifs = gifs.slice(0, limit);
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(storageKey, JSON.stringify(state.gifs));
  } catch {
    /* A full store costs the list, not the picker. */
  }
}
