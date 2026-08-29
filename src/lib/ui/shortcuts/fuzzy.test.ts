import { expect, test } from 'vitest';

import { fuzzyFilter, fuzzyScore } from './fuzzy';

test('an empty query matches everything with a zero score', () => {
  expect(fuzzyScore('anything', '')).toBe(0);
});

test('a subsequence matches regardless of case', () => {
  expect(fuzzyScore('Engineering Team', 'eng')).not.toBeNull();
  expect(fuzzyScore('Engineering Team', 'ENG')).not.toBeNull();
});

test('out-of-order letters do not match', () => {
  expect(fuzzyScore('cat', 'tac')).toBeNull();
});

test('a letter missing from the text does not match', () => {
  expect(fuzzyScore('Engineering', 'engz')).toBeNull();
});

test('a contiguous match scores higher than a scattered one', () => {
  const contiguous = fuzzyScore('devteam', 'dev');
  const scattered = fuzzyScore('duesevlop', 'dev');
  expect(contiguous).not.toBeNull();
  expect(scattered).not.toBeNull();
  expect(contiguous ?? 0).toBeGreaterThan(scattered ?? 0);
});

test('a match at the very start scores higher than one further in', () => {
  const atStart = fuzzyScore('room one', 'room');
  const later = fuzzyScore('the room one', 'room');
  expect(atStart).not.toBeNull();
  expect(later).not.toBeNull();
  expect(atStart ?? 0).toBeGreaterThan(later ?? 0);
});

test('fuzzyFilter returns everything, capped at the limit, for an empty query', () => {
  const items = ['a', 'b', 'c', 'd'];
  expect(fuzzyFilter(items, '', (item) => item, 2)).toEqual(['a', 'b']);
});

test('fuzzyFilter drops non-matches and ranks the rest by score', () => {
  const items = ['xdxexvx', 'no match here', 'xdevx'];
  expect(fuzzyFilter(items, 'dev', (item) => item, 10)).toEqual(['xdevx', 'xdxexvx']);
});

test('fuzzyFilter respects the limit after ranking', () => {
  const items = ['aardvark', 'aardwolf', 'aardappel'];
  expect(fuzzyFilter(items, 'aard', (item) => item, 1)).toHaveLength(1);
});
