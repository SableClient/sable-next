// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

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

async function loadStore(stored?: unknown) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(storageKey, JSON.stringify(stored));
  vi.resetModules();
  return import('./favorites.svelte');
}

async function loadRawStore(stored: string) {
  localStorage.clear();
  localStorage.setItem(storageKey, stored);
  vi.resetModules();
  return import('./favorites.svelte');
}

afterEach(() => {
  localStorage.clear();
});

test('a toggle adds, then removes, and persists either way', async () => {
  const { favoriteGifs, isFavorite, parseFavorites, toggleFavorite } = await loadStore();

  toggleFavorite(gif());
  expect(favoriteGifs()).toHaveLength(1);
  expect(isFavorite(favoriteGifs(), gif())).toBe(true);
  expect(parseFavorites(JSON.parse(localStorage.getItem(storageKey) ?? '[]'))).toEqual(
    favoriteGifs()
  );

  toggleFavorite(gif());
  expect(favoriteGifs()).toEqual([]);
  expect(localStorage.getItem(storageKey)).toBe('[]');
});

test('the same media url is one entry however the rest differs', async () => {
  const { favoriteGifs, toggleFavorite } = await loadStore();

  toggleFavorite(gif());
  toggleFavorite(gif({ title: 'renamed' }));
  expect(favoriteGifs()).toEqual([]);
});

test('an entry pointing off a provider CDN is dropped on read', async () => {
  const { favoriteGifs } = await loadStore([
    gif({ mediaUrl: 'https://evil.example/cat.gif' }),
    gif(),
  ]);

  expect(favoriteGifs().map((entry) => entry.mediaUrl)).toEqual([
    'https://media.tenor.com/abc/cat.gif',
  ]);
});

test('a preview off a provider CDN falls back to the media url', async () => {
  const { favoriteGifs } = await loadStore([gif({ previewUrl: 'https://evil.example/tiny.gif' })]);

  expect(favoriteGifs()[0].previewUrl).toBe('https://media.tenor.com/abc/cat.gif');
});

test('a store another tab corrupted reads as empty rather than throwing', async () => {
  for (const raw of ['not json', '{}', '[1, null, "x"]']) {
    expect((await loadRawStore(raw)).favoriteGifs()).toEqual([]);
  }
});

test('missing dimensions read back as zero, which the send path treats as absent', async () => {
  const { favoriteGifs } = await loadStore([{ mediaUrl: gif().mediaUrl }]);

  expect(favoriteGifs()[0]).toEqual({
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
