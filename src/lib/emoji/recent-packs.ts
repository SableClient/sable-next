const storageKey = 'sable.composer.recentEmotes';

export function readRecent(): string[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function writeRecent(shortcodes: readonly string[]): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(storageKey, JSON.stringify(shortcodes));
  } catch {
    /* A full or blocked store costs the ordering, not the picker. */
  }
}
