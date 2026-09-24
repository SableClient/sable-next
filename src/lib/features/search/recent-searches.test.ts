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

  rememberSearch('@erwan:example.org', 'deploy');
  rememberSearch('@erwan:example.org', 'in:General rollback');
  rememberSearch('@erwan:example.org', '  deploy ');

  expect(recentSearches('@erwan:example.org')).toEqual(['deploy', 'in:General rollback']);
});

test('recent searches are kept per account and capped', async () => {
  const { recentSearches, rememberSearch } = await loadStore();

  for (let index = 0; index < 15; index += 1)
    rememberSearch('@erwan:example.org', `q${String(index)}`);
  rememberSearch('@alice:example.org', 'alice only');

  expect(recentSearches('@erwan:example.org')).toHaveLength(10);
  expect(recentSearches('@erwan:example.org')[0]).toBe('q14');
  expect(recentSearches('@alice:example.org')).toEqual(['alice only']);
});

test('a blank query is not remembered', async () => {
  const { recentSearches, rememberSearch } = await loadStore();

  rememberSearch('@erwan:example.org', '   ');

  expect(recentSearches('@erwan:example.org')).toEqual([]);
});

test('recent searches survive a reload and ignore malformed storage', async () => {
  const { rememberSearch } = await loadStore();
  rememberSearch('@erwan:example.org', 'deploy');

  const reloaded = await loadStore(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  expect(reloaded.recentSearches('@erwan:example.org')).toEqual(['deploy']);

  const malformed = await loadStore({ '@erwan:example.org': [1, 'deploy', null] });
  expect(malformed.recentSearches('@erwan:example.org')).toEqual(['deploy']);
});

test('clearing forgets one account, and clearing everything forgets all of them', async () => {
  const { clearRecentSearches, recentSearches, rememberSearch } = await loadStore();
  rememberSearch('@erwan:example.org', 'deploy');
  rememberSearch('@alice:example.org', 'rollback');

  clearRecentSearches('@erwan:example.org');
  expect(recentSearches('@erwan:example.org')).toEqual([]);
  expect(recentSearches('@alice:example.org')).toEqual(['rollback']);

  clearRecentSearches();
  expect(recentSearches('@alice:example.org')).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
});
