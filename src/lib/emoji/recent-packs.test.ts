// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const STORAGE_KEY = 'sable.composer.recentStickers';

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
  const { readRecentStickers, writeRecentStickers } = await loadStore();
  writeRecentStickers(['mxc://example.org/wave', 'mxc://example.org/party']);
  expect(readRecentStickers()).toEqual(['mxc://example.org/wave', 'mxc://example.org/party']);
});

test('the newest pick leads and never repeats', async () => {
  const { readRecentStickers, rememberSticker } = await loadStore();
  rememberSticker('mxc://example.org/wave');
  rememberSticker('mxc://example.org/party');
  rememberSticker('mxc://example.org/wave');
  expect(readRecentStickers()).toEqual(['mxc://example.org/wave', 'mxc://example.org/party']);
});

test('a store holding something else does not break the picker', async () => {
  expect((await loadStore('{"not":"an array"}')).readRecentStickers()).toEqual([]);
  expect((await loadStore('not json at all')).readRecentStickers()).toEqual([]);
  expect((await loadStore('["ok", 3, null]')).readRecentStickers()).toEqual(['ok']);
});

test('a synced list that repeats a shortcode keeps its first place', async () => {
  const { parseShortcodes } = await loadStore();
  expect(parseShortcodes(['party', 'blobwave', 'party', 7])).toEqual(['party', 'blobwave']);
});
