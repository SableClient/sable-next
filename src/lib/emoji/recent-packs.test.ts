// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { readRecent, writeRecent } from '$lib/emoji/recent-packs';

afterEach(() => {
  localStorage.clear();
});

test('recents round-trip', () => {
  writeRecent(['blobwave', 'party']);
  expect(readRecent()).toEqual(['blobwave', 'party']);
});

test('a store holding something else does not break the picker', () => {
  localStorage.setItem('sable.composer.recentEmotes', '{"not":"an array"}');
  expect(readRecent()).toEqual([]);

  localStorage.setItem('sable.composer.recentEmotes', 'not json at all');
  expect(readRecent()).toEqual([]);

  localStorage.setItem('sable.composer.recentEmotes', '["ok", 3, null]');
  expect(readRecent()).toEqual(['ok']);
});
