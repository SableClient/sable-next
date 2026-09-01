import { QUICK_REACTIONS } from './quick-reactions';

export interface RecentReaction {
  emoji: string;
  total: number;
}

const STORAGE_KEY = 'sable-recent-reactions';
const LIMIT = 6;
const MAX_ENTRIES = 100;

const state = $state<{ entries: RecentReaction[] }>({ entries: load() });

function load(): RecentReaction[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    return parseRecentReactions(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function parseRecentReactions(value: unknown): RecentReaction[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [{ emoji: entry, total: 1 }];
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
      return [{ emoji: entry[0], total: entry[1] }];
    }
    if (entry === null || typeof entry !== 'object') return [];
    const record = entry as Partial<RecentReaction>;
    return typeof record.emoji === 'string' && typeof record.total === 'number'
      ? [{ emoji: record.emoji, total: record.total }]
      : [];
  });
}

export function recentReactionEntries(): RecentReaction[] {
  return state.entries;
}

export function readRecentReactions(): string[] {
  const recent = state.entries.map((entry) => entry.emoji);
  return [...recent, ...QUICK_REACTIONS.filter((entry) => !recent.includes(entry))].slice(0, LIMIT);
}

export function rememberReaction(emoji: string): void {
  const previous = state.entries.find((entry) => entry.emoji === emoji);
  write([
    { emoji, total: (previous?.total ?? 0) + 1 },
    ...state.entries.filter((entry) => entry.emoji !== emoji),
  ]);
}

export function adoptRecentReactions(entries: RecentReaction[]): void {
  write(entries);
}

function write(entries: RecentReaction[]): void {
  state.entries = entries.slice(0, MAX_ENTRIES);
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
  } catch (error) {
    console.debug('[sable reactions] recents not persisted', error);
  }
}
