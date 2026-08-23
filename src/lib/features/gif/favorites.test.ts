// @vitest-environment happy-dom

import { beforeEach, expect, test } from 'vitest';

import { isFavorite, readFavorites, toggleFavorite } from './favorites';
import type { GifResult } from './providers';

const storageKey = 'sable.composer.favoriteGifs';

const gif = (overrides: Partial<GifResult> = {}): GifResult => ({
  id: 'abc',
  title: 'a cat',
  mediaUrl: 'https://media.tenor.com/abc/cat.gif',
  previewUrl: 'https://media.tenor.com/abc/tiny.gif',
  width: 320,
  height: 240,
  size: 1000,
  mimetype: 'image/gif',
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
});

test('a toggle adds, then removes, and persists either way', () => {
  const added = toggleFavorite([], gif());
  expect(added).toHaveLength(1);
  expect(readFavorites()).toEqual(added);
  expect(isFavorite(added, gif())).toBe(true);

  const removed = toggleFavorite(added, gif());
  expect(removed).toEqual([]);
  expect(readFavorites()).toEqual([]);
});

test('the same media url is one entry however the rest differs', () => {
  const once = toggleFavorite([], gif());
  expect(toggleFavorite(once, gif({ title: 'renamed' }))).toEqual([]);
});

test('an entry pointing off a provider CDN is dropped on read', () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify([gif({ mediaUrl: 'https://evil.example/cat.gif' }), gif()])
  );

  expect(readFavorites().map((entry) => entry.mediaUrl)).toEqual([
    'https://media.tenor.com/abc/cat.gif',
  ]);
});

test('a preview off a provider CDN falls back to the media url', () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify([gif({ previewUrl: 'https://evil.example/tiny.gif' })])
  );

  expect(readFavorites()[0].previewUrl).toBe('https://media.tenor.com/abc/cat.gif');
});

test('a store another tab corrupted reads as empty rather than throwing', () => {
  for (const raw of ['not json', '{}', '[1, null, "x"]']) {
    localStorage.setItem(storageKey, raw);
    expect(readFavorites()).toEqual([]);
  }
});

test('missing dimensions read back as zero, which the send path treats as absent', () => {
  localStorage.setItem(storageKey, JSON.stringify([{ mediaUrl: gif().mediaUrl }]));

  expect(readFavorites()[0]).toEqual({
    id: '',
    title: 'GIF',
    mediaUrl: gif().mediaUrl,
    previewUrl: gif().mediaUrl,
    width: 0,
    height: 0,
    size: 0,
    mimetype: 'image/gif',
  });
});
