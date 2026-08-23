import { expect, test } from 'vitest';

import { parseSearchQuery } from './search-query';
import { chipText, composeQuery, splitTokenField } from './token-field';

function split(query: string) {
  const { chips, draft } = splitTokenField(query, parseSearchQuery(query));
  return { chips: chips.map((chip) => chipText(query, chip)), draft };
}

function roundTrip(query: string): string {
  const { chips, draft } = split(query);
  return composeQuery(chips, draft);
}

test('a query without operators is all draft', () => {
  expect(split('deploy broke')).toEqual({ chips: [], draft: 'deploy broke' });
});

test('the operator under the caret stays in the draft so it can be completed', () => {
  expect(split('deploy in:Ran')).toEqual({ chips: [], draft: 'deploy in:Ran' });
});

test('a trailing space commits the operator to a chip', () => {
  expect(split('deploy in:Random ')).toEqual({ chips: ['in:Random'], draft: 'deploy ' });
});

test('an operator followed by more words is committed', () => {
  expect(split('in:Random deploy')).toEqual({ chips: ['in:Random'], draft: 'deploy' });
});

test('a committed chip leaves no leading space behind', () => {
  expect(split('in:Random ')).toEqual({ chips: ['in:Random'], draft: '' });
});

test('several committed operators all become chips', () => {
  expect(split('in:Random from:ada deploy')).toEqual({
    chips: ['in:Random', 'from:ada'],
    draft: 'deploy',
  });
});

test('a quoted value keeps its quotes in the chip text', () => {
  expect(split('in:"Design crew" deploy')).toEqual({
    chips: ['in:"Design crew"'],
    draft: 'deploy',
  });
});

test('a negated operator keeps its dash', () => {
  expect(split('-from:ada deploy')).toEqual({ chips: ['-from:ada'], draft: 'deploy' });
});

test('a word before a chip is hoisted behind it', () => {
  expect(roundTrip('deploy in:Random ')).toBe('in:Random deploy ');
});

test('interior whitespace in the draft survives a committed chip', () => {
  expect(split('in:Random hello  world')).toEqual({
    chips: ['in:Random'],
    draft: 'hello  world',
  });
});

test('a trailing space the user typed is kept', () => {
  expect(split('in:Random hello ')).toEqual({ chips: ['in:Random'], draft: 'hello ' });
});

test('the first pass preserves the query, not just the second', () => {
  for (const query of [
    'deploy',
    'deploy in:Ran',
    'in:Random deploy',
    'in:Random hello  world',
    'in:Random from:ada ',
    'in:"Design crew" -from:ada deploy',
    'in:Random  ',
  ]) {
    expect(roundTrip(query)).toBe(query);
  }
});

test('splitting a composed query gives the same split back', () => {
  for (const query of [
    'deploy',
    'deploy in:Ran',
    'in:Random deploy',
    'in:Random from:ada ',
    'in:"Design crew" -from:ada deploy',
  ]) {
    expect(roundTrip(roundTrip(query))).toBe(roundTrip(query));
  }
});

test('composing without chips leaves the draft untouched', () => {
  expect(composeQuery([], 'deploy broke')).toBe('deploy broke');
});

test('composing onto an empty draft leaves a trailing space to type into', () => {
  expect(composeQuery(['in:Random'], '')).toBe('in:Random ');
});

test('a phrase is not a chip', () => {
  expect(split('"exact phrase" deploy')).toEqual({ chips: [], draft: '"exact phrase" deploy' });
});

test('an unsupported operator is not a chip', () => {
  expect(split('pinned:true deploy')).toEqual({ chips: [], draft: 'pinned:true deploy' });
});
