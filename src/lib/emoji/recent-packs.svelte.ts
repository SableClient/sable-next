import { readJson, writeJson } from '#lib/platform/local-json.js';

export type RecentUsage = 'emoticon' | 'sticker';

const storageKeys: Record<RecentUsage, string> = {
  emoticon: 'sable.composer.recentEmotes',
  sticker: 'sable.composer.recentStickers',
};
const limit = 32;

const state = $state<Record<RecentUsage, string[]>>({
  emoticon: load('emoticon'),
  sticker: load('sticker'),
});

function load(usage: RecentUsage): string[] {
  return readJson(storageKeys[usage], parseShortcodes, []);
}

export function parseShortcodes(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .filter((entry, index, all) => all.indexOf(entry) === index)
    : [];
}

export function readRecent(usage: RecentUsage = 'emoticon'): string[] {
  return state[usage];
}

export function rememberEmote(shortcode: string, usage: RecentUsage = 'emoticon'): void {
  writeRecent([shortcode, ...state[usage].filter((entry) => entry !== shortcode)], usage);
}

export function writeRecent(shortcodes: readonly string[], usage: RecentUsage = 'emoticon'): void {
  state[usage] = shortcodes.slice(0, limit);
  writeJson(storageKeys[usage], state[usage]);
}
