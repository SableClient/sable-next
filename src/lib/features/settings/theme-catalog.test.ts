import { expect, test } from 'vitest';

import type { ThemeFileMetadata } from '#lib/settings/theme-file.js';

import { catalogFileUrl, filterCatalog, type CatalogEntry } from './theme-catalog';

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
  'http://raw.githubusercontent.com/SableClient/themes/main/night.sable.css',
  'https://raw.githubusercontent.com/someone/else/main/night.sable.css',
  'https://evil.example/night.sable.css',
  'https://raw.githubusercontent.com/SableClient/themes/main/night.sable.css?track=1',
  'https://user:pass@raw.githubusercontent.com/SableClient/themes/main/x.sable.css',
  'https://raw.githubusercontent.com/SableClient/themes/../other/x.sable.css',
  'data:text/css,.x{}',
  'javascript:alert(1)',
  42,
])('a catalogue file outside the catalogue repository is refused: %s', (url) => {
  expect(catalogFileUrl(url)).toBeNull();
});

test('a catalogue file in the catalogue repository is accepted', () => {
  const url = 'https://raw.githubusercontent.com/SableClient/themes/main/themes/night.sable.css';
  expect(catalogFileUrl(url)).toBe(url);
});
