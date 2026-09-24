import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable.search.recent';
const LIMIT = 10;

type Store = Record<string, string[]>;

const state = $state<{ byAccount: Store }>({ byAccount: readJson(STORAGE_KEY, parse, {}) });

function parse(value: unknown): Store {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).map(([userId, queries]) => [
      userId,
      Array.isArray(queries)
        ? queries.filter((query): query is string => typeof query === 'string')
        : [],
    ])
  );
}

export function recentSearches(userId: string): string[] {
  return state.byAccount[userId] ?? [];
}

export function rememberSearch(userId: string, query: string): void {
  const trimmed = query.trim();
  if (trimmed === '') return;

  const kept = recentSearches(userId).filter((entry) => entry !== trimmed);
  write({ ...state.byAccount, [userId]: [trimmed, ...kept].slice(0, LIMIT) });
}

export function clearRecentSearches(userId?: string): void {
  if (userId === undefined) {
    state.byAccount = {};
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const { [userId]: _dropped, ...rest } = state.byAccount;
  write(rest);
}

function write(byAccount: Store): void {
  state.byAccount = byAccount;
  writeJson(STORAGE_KEY, byAccount, '[sable search] recent searches not persisted');
}
