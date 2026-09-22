import { expect, test } from 'vitest';

import { abbreviationKey, readAbbreviations, upsertAbbreviation } from './abbreviations';

test('reads a term and definition', () => {
  expect(
    readAbbreviations({ entries: [{ term: 'MSC', definition: 'Matrix Spec Change' }] })
  ).toEqual([{ term: 'MSC', definition: 'Matrix Spec Change' }]);
});

test('reads a cased term', () => {
  expect(
    readAbbreviations({ entries: [{ term: 'DO', definition: 'Digital Ocean', cased: true }] })
  ).toEqual([{ term: 'DO', definition: 'Digital Ocean', cased: true }]);
});

test('ignores a non-boolean cased value', () => {
  expect(
    readAbbreviations({ entries: [{ term: 'DO', definition: 'Digital Ocean', cased: 'yes' }] })
  ).toEqual([{ term: 'DO', definition: 'Digital Ocean' }]);
});

test('drops malformed entries', () => {
  expect(
    readAbbreviations({
      entries: [
        null,
        'MSC',
        { term: '', definition: 'empty term' },
        { term: 'MSC' },
        { term: 'PR', definition: 'Pull request' },
      ],
    })
  ).toEqual([{ term: 'PR', definition: 'Pull request' }]);
});

test('reads nothing from a malformed payload', () => {
  expect(readAbbreviations(null)).toEqual([]);
  expect(readAbbreviations({ entries: 'nope' })).toEqual([]);
});

test('keys an uncased term case-insensitively and a cased term exactly', () => {
  expect(abbreviationKey({ term: 'Do', definition: '' })).toBe(
    abbreviationKey({ term: 'do', definition: '' })
  );
  expect(abbreviationKey({ term: 'DO', definition: '', cased: true })).not.toBe(
    abbreviationKey({ term: 'DO', definition: '' })
  );
});

test('upsert appends a new abbreviation', () => {
  expect(
    upsertAbbreviation([{ term: 'MSC', definition: 'Matrix Spec Change' }], null, {
      term: 'PR',
      definition: 'Pull request',
    })
  ).toEqual([
    { term: 'MSC', definition: 'Matrix Spec Change' },
    { term: 'PR', definition: 'Pull request' },
  ]);
});

test('upsert replaces the entry being edited, even when its term changes', () => {
  expect(
    upsertAbbreviation(
      [
        { term: 'MSC', definition: 'Matrix Spec Change' },
        { term: 'PR', definition: 'Pull request' },
      ],
      abbreviationKey({ term: 'PR', definition: 'Pull request' }),
      { term: 'PRs', definition: 'Pull requests' }
    )
  ).toEqual([
    { term: 'MSC', definition: 'Matrix Spec Change' },
    { term: 'PRs', definition: 'Pull requests' },
  ]);
});

test('upsert replaces an uncased term regardless of its casing', () => {
  expect(
    upsertAbbreviation([{ term: 'MSC', definition: 'old' }], null, {
      term: 'msc',
      definition: 'new',
    })
  ).toEqual([{ term: 'msc', definition: 'new' }]);
});

test('upsert keeps an edited abbreviation in place', () => {
  expect(
    upsertAbbreviation(
      [
        { term: 'one', definition: 'first' },
        { term: 'B', definition: 'old' },
        { term: 'C', definition: 'third' },
      ],
      abbreviationKey({ term: 'B', definition: 'old' }),
      { term: 'B', definition: 'new' }
    )
  ).toEqual([
    { term: 'one', definition: 'first' },
    { term: 'B', definition: 'new' },
    { term: 'C', definition: 'third' },
  ]);
});

test('upsert lets a cased term and an uncased term share the same letters', () => {
  expect(
    upsertAbbreviation([{ term: 'do', definition: 'to do' }], null, {
      term: 'DO',
      definition: 'Digital Ocean',
      cased: true,
    })
  ).toEqual([
    { term: 'do', definition: 'to do' },
    { term: 'DO', definition: 'Digital Ocean', cased: true },
  ]);
});
