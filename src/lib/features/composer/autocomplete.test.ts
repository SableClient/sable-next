import { expect, test } from 'vitest';

import { activeQuery, replaceQuery } from './autocomplete';

test('a sigil opens a query at the start of the draft or after whitespace', () => {
  expect(activeQuery('@no', 3)).toEqual({ sigil: '@', query: 'no', start: 0, end: 3 });
  expect(activeQuery('hey @no', 7)).toEqual({ sigil: '@', query: 'no', start: 4, end: 7 });
  expect(activeQuery('blob :wav', 9)).toEqual({ sigil: ':', query: 'wav', start: 5, end: 9 });
  expect(activeQuery('join #general', 13)).toEqual({
    sigil: '#',
    query: 'general',
    start: 5,
    end: 13,
  });
  expect(activeQuery('join #general:example.org', 25)).toEqual({
    sigil: '#',
    query: 'general:example.org',
    start: 5,
    end: 25,
  });
});

test('a leading slash opens command autocomplete, but inline slashes do not', () => {
  expect(activeQuery('/', 1)).toEqual({ sigil: '/', query: '', start: 0, end: 1 });
  expect(activeQuery('/me', 3)).toEqual({ sigil: '/', query: 'me', start: 0, end: 3 });
  expect(activeQuery('hello /me', 9)).toBeNull();
  expect(activeQuery('//me', 4)).toBeNull();
});

test('a sigil glued to other text opens nothing', () => {
  expect(activeQuery('mail@example.org', 16)).toBeNull();
  expect(activeQuery('http://host', 11)).toBeNull();
});

test('the query ends at the first space, and a bare sigil opens nothing', () => {
  expect(activeQuery('@', 1)).toBeNull();
  expect(activeQuery('@no one', 7)).toBeNull();
});

test('a one-letter needle opens a member but not an emoji', () => {
  expect(activeQuery('@n', 2)).toEqual({ sigil: '@', query: 'n', start: 0, end: 2 });
  expect(activeQuery('#g', 2)).toEqual({ sigil: '#', query: 'g', start: 0, end: 2 });
  expect(activeQuery(':w', 2)).toBeNull();
  expect(activeQuery(':wa', 3)).toEqual({ sigil: ':', query: 'wa', start: 0, end: 3 });
});

test('a colon mid-prose no longer opens the picker on one letter', () => {
  expect(activeQuery('note:t', 6)).toBeNull();
});

test('the nearest sigil to the caret wins', () => {
  expect(activeQuery('hey @nour :wav', 14)).toEqual({
    sigil: ':',
    query: 'wav',
    start: 10,
    end: 14,
  });
});

test('a closed shortcode is finished text, not a query', () => {
  expect(activeQuery('nice :blob:', 11)).toBeNull();
});

test('the query is read at the caret, not at the end of the draft', () => {
  expect(activeQuery('@no and more', 3)).toEqual({ sigil: '@', query: 'no', start: 0, end: 3 });
});

test('replacing a query keeps whatever follows the caret', () => {
  const draft = 'hey @no and more';
  const query = activeQuery(draft, 7);
  if (!query) throw new Error('expected a query');
  expect(replaceQuery(draft, query, 'Member ')).toBe('hey Member  and more');
});

test('an admin command opens on its prefix and completes the word at the caret', () => {
  expect(activeQuery('!', 1)).toEqual({ sigil: '!', query: '!', start: 0, end: 1 });
  expect(activeQuery('\\!adm', 5)).toEqual({ sigil: '!', query: '\\!adm', start: 0, end: 5 });
  expect(activeQuery('!admin rooms mod', 16)).toEqual({
    sigil: '!',
    query: '!admin rooms mod',
    start: 13,
    end: 16,
  });
  expect(activeQuery('!admin rooms ', 13)).toEqual({
    sigil: '!',
    query: '!admin rooms ',
    start: 13,
    end: 13,
  });
});

test('other text after a bang is not an admin command', () => {
  expect(activeQuery('!hello', 6)).toBeNull();
  expect(activeQuery('!adminx', 7)).toBeNull();
  expect(activeQuery('!hi there', 9)).toBeNull();
  expect(activeQuery('hey !admin', 10)).toBeNull();
  expect(activeQuery('!admin users create @no', 23)).toEqual({
    sigil: '@',
    query: 'no',
    start: 20,
    end: 23,
  });
});
