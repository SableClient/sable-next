// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const STORAGE_KEY = 'sable.search.recent';

async function loadStore(stored?: unknown) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  vi.resetModules();
  return import('./recent-searches.svelte.js');
}

afterEach(() => {
  localStorage.clear();
});

test('the newest search leads and a repeat moves to the front', async () => {
  const { recentSearches, rememberSearch } = await loadStore();

  rememberSearch('@kris:example.org', 'deploy');
  rememberSearch('@kris:example.org', 'in:General rollback');
  rememberSearch('@kris:example.org', '  deploy ');

  expect(recentSearches('@kris:example.org')).toEqual(['deploy', 'in:General rollback']);
});

test('recent searches are kept per account and capped', async () => {
  const { recentSearches, rememberSearch } = await loadStore();

  for (let index = 0; index < 15; index += 1)
    rememberSearch('@kris:example.org', `q${String(index)}`);
  rememberSearch('@alice:example.org', 'alice only');

  expect(recentSearches('@kris:example.org')).toHaveLength(10);
  expect(recentSearches('@kris:example.org')[0]).toBe('q14');
  expect(recentSearches('@alice:example.org')).toEqual(['alice only']);
});

test('a blank query is not remembered', async () => {
  const { recentSearches, rememberSearch } = await loadStore();

  rememberSearch('@kris:example.org', '   ');

  expect(recentSearches('@kris:example.org')).toEqual([]);
});

test('recent searches survive a reload and ignore malformed storage', async () => {
  const { rememberSearch } = await loadStore();
  rememberSearch('@kris:example.org', 'deploy');

  const reloaded = await loadStore(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  expect(reloaded.recentSearches('@kris:example.org')).toEqual(['deploy']);

  const malformed = await loadStore({ '@kris:example.org': [1, 'deploy', null] });
  expect(malformed.recentSearches('@kris:example.org')).toEqual(['deploy']);
});

test('clearing forgets one account, and clearing everything forgets all of them', async () => {
  const { clearRecentSearches, recentSearches, rememberSearch } = await loadStore();
  rememberSearch('@kris:example.org', 'deploy');
  rememberSearch('@alice:example.org', 'rollback');

  clearRecentSearches('@kris:example.org');
  expect(recentSearches('@kris:example.org')).toEqual([]);
  expect(recentSearches('@alice:example.org')).toEqual(['rollback']);

  clearRecentSearches();
  expect(recentSearches('@alice:example.org')).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
});
