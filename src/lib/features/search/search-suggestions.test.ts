import { expect, test } from 'vitest';

import { applySuggestion, partialAt, suggestionsFor } from './search-suggestions';

const sources = {
  rooms: [
    {
      id: '!design:example.org',
      alias: '#design-crew:example.org',
      name: 'Design crew',
      avatarUrl: null,
    },
    { id: '!general:example.org', alias: '#general:example.org', name: 'General', avatarUrl: null },
  ],
  senders: [
    { userId: '@ada:example.org', displayName: 'Ada', avatarUrl: null },
    { userId: '@erwan:example.org', displayName: 'Erwan', avatarUrl: null },
  ],
};

test('a bare word suggests matching operators', () => {
  expect(suggestionsFor('fr', sources).map((entry) => entry.label)).toEqual(['from:']);
  expect(suggestionsFor('deploy i', sources).map((entry) => entry.label)).toEqual(['in:']);
});

test('an empty token suggests nothing unless the list is asked for', () => {
  expect(suggestionsFor('', sources)).toEqual([]);
  expect(suggestionsFor('deploy ', sources)).toEqual([]);
  expect(suggestionsFor('message in:Random ', sources)).toEqual([]);
});

test('the operator cheat-sheet is available on request', () => {
  expect(suggestionsFor('', sources, true).map((entry) => entry.label)).toEqual([
    'in:',
    'from:',
    'mentions:',
    'has:',
    'before:',
    'after:',
    'during:',
  ]);
});

test('an operator suggestion explains what it takes', () => {
  const [suggestion] = suggestionsFor('in', sources);

  expect(suggestion.detail).toBe('room');
});

test('in: suggests rooms by alias and name', () => {
  expect(suggestionsFor('in:', sources).map((entry) => entry.label)).toEqual([
    'Design crew',
    'General',
  ]);
  expect(suggestionsFor('in:gen', sources).map((entry) => entry.label)).toEqual(['General']);
  expect(suggestionsFor('in:crew', sources).map((entry) => entry.label)).toEqual(['Design crew']);
});

test('a room whose alias has spaces in its name is quoted on insert', () => {
  const [suggestion] = suggestionsFor('in:crew', sources);

  expect(suggestion.insert).toBe('in:#design-crew:example.org ');
  expect(applySuggestion('deploy in:crew', suggestion)).toBe('deploy in:#design-crew:example.org ');
});

test('from: and mentions: suggest senders by name and insert their id', () => {
  const [byName] = suggestionsFor('from:Ad', sources);
  expect(byName.label).toBe('Ada');
  expect(byName.detail).toBe('@ada:example.org');
  expect(byName.insert).toBe('from:@ada:example.org ');

  expect(suggestionsFor('mentions:erwan', sources).map((entry) => entry.label)).toEqual(['Erwan']);
});

test('has: suggests the attachment kinds the core knows', () => {
  expect(suggestionsFor('has:', sources).map((entry) => entry.label)).toEqual([
    'image',
    'video',
    'audio',
    'file',
    'link',
  ]);
  expect(suggestionsFor('has:im', sources).map((entry) => entry.label)).toEqual(['image']);
});

test('a negated operator keeps its dash when completed', () => {
  const [suggestion] = suggestionsFor('-fr', sources);

  expect(suggestion.insert).toBe('-from:');
  expect(applySuggestion('deploy -fr', suggestion)).toBe('deploy -from:');
});

test('a quoted value in progress is not split at its space', () => {
  const partial = partialAt('in:"Design cr');

  expect(partial.operator).toBe('in');
  expect(partial.value).toBe('Design cr');
});

test('applying a suggestion replaces only the token being typed', () => {
  const [suggestion] = suggestionsFor('broken deploy in:gen', sources);

  expect(applySuggestion('broken deploy in:gen', suggestion)).toBe(
    'broken deploy in:#general:example.org '
  );
});

test('an unknown operator suggests no values', () => {
  expect(suggestionsFor('colour:re', sources)).toEqual([]);
});
