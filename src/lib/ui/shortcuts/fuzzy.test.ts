import { expect, test } from 'vitest';

import { fuzzyFilter, fuzzyMatchParts } from './fuzzy';

const match = (text: string, query: string): string[] =>
  fuzzyFilter([text], query, (item) => item, 1);

test('a subsequence matches regardless of case', () => {
  expect(match('Engineering Team', 'eng')).toHaveLength(1);
  expect(match('Engineering Team', 'ENG')).toHaveLength(1);
});

test('out-of-order letters do not match', () => {
  expect(match('cat', 'tac')).toEqual([]);
});

test('a letter missing from the text does not match', () => {
  expect(match('Engineering', 'engz')).toEqual([]);
});

test('an accent in the name does not stop a plain query', () => {
  expect(match('Café Crème', 'creme')).toHaveLength(1);
});

test('a contiguous match ranks above a scattered one', () => {
  expect(fuzzyFilter(['duesevlop', 'devteam'], 'dev', (item) => item, 10)).toEqual([
    'devteam',
    'duesevlop',
  ]);
});

test('a match at the very start ranks above one further in', () => {
  expect(fuzzyFilter(['the room one', 'room one'], 'room', (item) => item, 10)).toEqual([
    'room one',
    'the room one',
  ]);
});

test('fuzzyFilter returns everything, capped at the limit, for an empty query', () => {
  const items = ['a', 'b', 'c', 'd'];
  expect(fuzzyFilter(items, '', (item) => item, 2)).toEqual(['a', 'b']);
});

test('fuzzyFilter drops non-matches and ranks the rest', () => {
  const items = ['xdxexvx', 'no match here', 'xdevx'];
  expect(fuzzyFilter(items, 'dev', (item) => item, 10)).toEqual(['xdevx', 'xdxexvx']);
});

test('fuzzyFilter respects the limit after ranking', () => {
  const items = ['aardvark', 'aardwolf', 'aardappel'];
  expect(fuzzyFilter(items, 'aard', (item) => item, 1)).toHaveLength(1);
});

test('the matched letters are split out for highlighting', () => {
  expect(fuzzyMatchParts('Sable Dev', 'dev')).toEqual([
    { text: 'Sable ', match: false },
    { text: 'Dev', match: true },
  ]);
  expect(fuzzyMatchParts('Sable', 'xyz')).toEqual([{ text: 'Sable', match: false }]);
});
