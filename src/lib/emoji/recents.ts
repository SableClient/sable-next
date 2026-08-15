import { QUICK_REACTIONS } from './emoji';

const STORAGE_KEY = 'sable-recent-reactions';
const LIMIT = 6;

export function readRecentReactions(): string[] {
  if (typeof localStorage === 'undefined') return [...QUICK_REACTIONS];

  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [...QUICK_REACTIONS];
  }
  if (!Array.isArray(stored)) return [...QUICK_REACTIONS];

  const recent = stored.filter((entry): entry is string => typeof entry === 'string');
  const filled = [...recent, ...QUICK_REACTIONS.filter((entry) => !recent.includes(entry))];
  return filled.slice(0, LIMIT);
}

export function rememberReaction(emoji: string): void {
  const next = [emoji, ...readRecentReactions().filter((entry) => entry !== emoji)].slice(0, LIMIT);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.debug('[sable reactions] recents not persisted', error);
  }
}
