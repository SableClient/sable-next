// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const STORAGE_KEY = 'sable.composer.recentEmotes';

async function loadStore(stored?: string) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(STORAGE_KEY, stored);
  vi.resetModules();
  return import('#lib/emoji/recent-packs.svelte.js');
}

afterEach(() => {
  localStorage.clear();
});

test('recents round-trip', async () => {
  const { readRecent, writeRecent } = await loadStore();
  writeRecent(['blobwave', 'party']);
  expect(readRecent()).toEqual(['blobwave', 'party']);
});

test('the newest pick leads and never repeats', async () => {
  const { readRecent, rememberEmote } = await loadStore();
  rememberEmote('blobwave');
  rememberEmote('party');
  rememberEmote('blobwave');
  expect(readRecent()).toEqual(['blobwave', 'party']);
});

test('a store holding something else does not break the picker', async () => {
  expect((await loadStore('{"not":"an array"}')).readRecent()).toEqual([]);
  expect((await loadStore('not json at all')).readRecent()).toEqual([]);
  expect((await loadStore('["ok", 3, null]')).readRecent()).toEqual(['ok']);
});
