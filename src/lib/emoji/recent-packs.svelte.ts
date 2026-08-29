const storageKey = 'sable.composer.recentEmotes';
const limit = 32;

const state = $state<{ shortcodes: string[] }>({ shortcodes: load() });

function load(): string[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    return parseShortcodes(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
  } catch {
    return [];
  }
}

export function parseShortcodes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function readRecent(): string[] {
  return state.shortcodes;
}

export function rememberEmote(shortcode: string): void {
  writeRecent([shortcode, ...state.shortcodes.filter((entry) => entry !== shortcode)]);
}

export function writeRecent(shortcodes: readonly string[]): void {
  state.shortcodes = shortcodes.slice(0, limit);
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(storageKey, JSON.stringify(state.shortcodes));
  } catch {
    /* A full or blocked store costs the ordering, not the picker. */
  }
}
