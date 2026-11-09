import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable.composer.recentStickers';
const limit = 32;

const state = $state({ stickers: readJson(STORAGE_KEY, parseShortcodes, []) });

export function parseShortcodes(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .filter((entry, index, all) => all.indexOf(entry) === index)
    : [];
}

export function readRecentStickers(): string[] {
  return state.stickers;
}

export function rememberSticker(url: string): void {
  writeRecentStickers([url, ...state.stickers.filter((entry) => entry !== url)]);
}

export function writeRecentStickers(urls: readonly string[]): void {
  state.stickers = urls.slice(0, limit);
  writeJson(STORAGE_KEY, state.stickers);
}
