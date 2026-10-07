import { expect, test, vi } from 'vitest';

import type { ThemeFileMetadata } from '#lib/settings/theme-file.js';

import {
  catalogFileUrl,
  filterCatalog,
  loadCatalog,
  resetCatalog,
  type CatalogEntry,
} from './theme-catalog';

function entry(
  kind: CatalogEntry['kind'],
  name: string,
  meta: Partial<ThemeFileMetadata> = {}
): CatalogEntry {
  return {
    kind,
    basename: name.toLowerCase(),
    fullUrl: `https://example.org/${name}.sable.css`,
    meta: {
      name,
      author: null,
      description: null,
      kind: 'light',
      contrast: 'low',
      tags: [],
      ...meta,
    },
    swatches: [],
  };
}

const entries = [
  entry('theme', 'Night', { kind: 'dark', contrast: 'high', author: 'ana' }),
  entry('theme', 'Day'),
  entry('tweak', 'Round corners', { tags: ['shape'] }),
];

const all = { query: '', kind: 'all', highContrast: false } as const;

test('sorts by name and keeps everything without a filter', () => {
  expect(filterCatalog(entries, all).map((item) => item.meta.name)).toEqual([
    'Day',
    'Night',
    'Round corners',
  ]);
});

test('the kind and contrast filters apply to themes only', () => {
  expect(filterCatalog(entries, { ...all, kind: 'dark' }).map((item) => item.meta.name)).toEqual([
    'Night',
    'Round corners',
  ]);
  expect(
    filterCatalog(entries, { ...all, highContrast: true }).map((item) => item.meta.name)
  ).toEqual(['Night', 'Round corners']);
});

test('the search matches the name, the author and the tags', () => {
  expect(filterCatalog(entries, { ...all, query: 'ANA' }).map((item) => item.meta.name)).toEqual([
    'Night',
  ]);
  expect(filterCatalog(entries, { ...all, query: 'shape' }).map((item) => item.meta.name)).toEqual([
    'Round corners',
  ]);
});

test.each([
  'http://git.sable.moe/SableClient/themes/raw/branch/main/night.sable.css',
  'https://git.sable.moe/someone/else/raw/branch/main/night.sable.css',
  'https://evil.example/night.sable.css',
  'https://git.sable.moe/SableClient/themes/raw/branch/main/night.sable.css?track=1',
  'https://user:pass@git.sable.moe/SableClient/themes/raw/branch/main/x.sable.css',
  'https://git.sable.moe/SableClient/themes/raw/branch/../other/x.sable.css',
  'data:text/css,.x{}',
  'javascript:alert(1)',
  42,
])('a catalogue file outside the catalogue repository is refused: %s', (url) => {
  expect(catalogFileUrl(url)).toBeNull();
});

test('a catalogue file in the catalogue repository is accepted', () => {
  const url = 'https://git.sable.moe/SableClient/themes/raw/branch/main/themes/night.sable.css';
  expect(catalogFileUrl(url)).toBe(url);
});

test('a reset catalogue is fetched again, revalidating past the HTTP cache', async () => {
  const fetch = vi.fn(() => Promise.resolve(Response.json({ version: 1, themes: [], tweaks: [] })));
  vi.stubGlobal('fetch', fetch);
  await loadCatalog(() => {});
  await loadCatalog(() => {});
  expect(fetch).toHaveBeenCalledTimes(1);
  resetCatalog();
  await loadCatalog(() => {});
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ cache: 'no-cache' })
  );
  vi.unstubAllGlobals();
});
