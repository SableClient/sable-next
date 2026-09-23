import { isRecord } from '#lib/guards.js';
import { readJson, writeJson } from '#lib/platform/local-json.js';

import { isAllowedGifMediaUrl, type GifResult } from './providers';

const storageKey = 'sable.composer.favoriteGifs';
const recentKey = 'sable.composer.recentGifs';
const limit = 64;
const recentLimit = 32;

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

function load(key: string): GifResult[] {
  return readJson(key, parseFavorites, []);
}

const state = $state<{ gifs: GifResult[]; recent: GifResult[] }>({
  gifs: load(storageKey),
  recent: load(recentKey),
});

export function favoriteGifs(): GifResult[] {
  return state.gifs;
}

export function isFavorite(gifs: readonly GifResult[], gif: GifResult): boolean {
  return gifs.some((entry) => entry.mediaUrl === gif.mediaUrl);
}

export function recentGifs(): GifResult[] {
  return state.recent;
}

export function rememberGif(gif: GifResult): void {
  writeRecent([gif, ...state.recent.filter((entry) => entry.mediaUrl !== gif.mediaUrl)]);
}

export function adoptRecentGifs(gifs: readonly GifResult[]): void {
  writeRecent(gifs);
}

function writeRecent(gifs: readonly GifResult[]): void {
  state.recent = gifs.slice(0, recentLimit);
  writeJson(recentKey, state.recent);
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
  writeJson(storageKey, state.gifs);
}
