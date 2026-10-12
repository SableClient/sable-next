import { expect, test } from 'vitest';

import { abbreviationKey, splitTerms, upsertAbbreviation } from './abbreviations';

test('keys an uncased term case-insensitively and a cased term exactly', () => {
  expect(abbreviationKey({ term: 'Do', definition: '', cased: false })).toBe(
    abbreviationKey({ term: 'do', definition: '', cased: false })
  );
  expect(abbreviationKey({ term: 'DO', definition: '', cased: true })).not.toBe(
    abbreviationKey({ term: 'DO', definition: '', cased: false })
  );
});

test('upsert appends a new abbreviation', () => {
  expect(
    upsertAbbreviation([{ term: 'MSC', definition: 'Matrix Spec Change', cased: false }], null, {
      term: 'PR',
      definition: 'Pull request',
      cased: false,
    })
  ).toEqual([
    { term: 'MSC', definition: 'Matrix Spec Change', cased: false },
    { term: 'PR', definition: 'Pull request', cased: false },
  ]);
});

test('upsert replaces the entry being edited, even when its term changes', () => {
  expect(
    upsertAbbreviation(
      [
        { term: 'MSC', definition: 'Matrix Spec Change', cased: false },
        { term: 'PR', definition: 'Pull request', cased: false },
      ],
      abbreviationKey({ term: 'PR', definition: 'Pull request', cased: false }),
      { term: 'PRs', definition: 'Pull requests', cased: false }
    )
  ).toEqual([
    { term: 'MSC', definition: 'Matrix Spec Change', cased: false },
    { term: 'PRs', definition: 'Pull requests', cased: false },
  ]);
});

test('upsert replaces an uncased term regardless of its casing', () => {
  expect(
    upsertAbbreviation([{ term: 'MSC', definition: 'old', cased: false }], null, {
      term: 'msc',
      definition: 'new',
      cased: false,
    })
  ).toEqual([{ term: 'msc', definition: 'new', cased: false }]);
});

test('upsert keeps an edited abbreviation in place', () => {
  expect(
    upsertAbbreviation(
      [
        { term: 'one', definition: 'first', cased: false },
        { term: 'B', definition: 'old', cased: false },
        { term: 'C', definition: 'third', cased: false },
      ],
      abbreviationKey({ term: 'B', definition: 'old', cased: false }),
      { term: 'B', definition: 'new', cased: false }
    )
  ).toEqual([
    { term: 'one', definition: 'first', cased: false },
    { term: 'B', definition: 'new', cased: false },
    { term: 'C', definition: 'third', cased: false },
  ]);
});

test('upsert lets a cased term and an uncased term share the same letters', () => {
  expect(
    upsertAbbreviation([{ term: 'do', definition: 'to do', cased: false }], null, {
      term: 'DO',
      definition: 'Digital Ocean',
      cased: true,
    })
  ).toEqual([
    { term: 'do', definition: 'to do', cased: false },
    { term: 'DO', definition: 'Digital Ocean', cased: true },
  ]);
});

test('splits comma-separated terms and drops empties', () => {
  expect(splitTerms(' id1, id1/ ,, ')).toEqual(['id1', 'id1/']);
  expect(splitTerms(',')).toEqual([]);
});
