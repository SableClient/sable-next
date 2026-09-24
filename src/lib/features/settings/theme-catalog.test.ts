import { expect, test } from 'vitest';

import type { ThemeFileMetadata } from '#lib/settings/theme-file.js';

import { filterCatalog, type CatalogEntry } from './theme-catalog';

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
