import { expect, test } from 'vitest';

import { applySuggestion, enterAccepts, partialAt, suggestionsFor } from './search-suggestions';

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
  spaces: [
    { id: '!eng:example.org', alias: '#eng:example.org', name: 'Engineering', avatarUrl: null },
    { id: '!social:example.org', alias: null, name: 'Social', avatarUrl: null },
  ],
};

test('a bare word suggests matching operators', () => {
  expect(suggestionsFor('fr', sources).map((entry) => entry.label)).toEqual(['from:']);
  expect(suggestionsFor('deploy i', sources).map((entry) => entry.label)).toEqual(['in:', 'is:']);
});

test('an empty token suggests nothing unless the list is asked for', () => {
  expect(suggestionsFor('', sources)).toEqual([]);
  expect(suggestionsFor('deploy ', sources)).toEqual([]);
  expect(suggestionsFor('message in:Random ', sources)).toEqual([]);
});

test('the operator cheat-sheet is available on request', () => {
  expect(suggestionsFor('', sources, true).map((entry) => entry.label)).toEqual([
    'in:',
    'space:',
    'from:',
    'mentions:',
    'has:',
    'before:',
    'after:',
    'during:',
    'on:',
    'with:',
    'is:',
    'pinned:',
    'regex:',
  ]);
});

test('is:, pinned:, has:pin and with: suggest their values', () => {
  expect(suggestionsFor('is:', sources).map((entry) => entry.label)).toEqual(['thread', 'state']);
  expect(suggestionsFor('pinned:', sources).map((entry) => entry.label)).toEqual(['true', 'false']);
  expect(suggestionsFor('has:p', sources).map((entry) => entry.label)).toEqual([
    'poll',
    'pin',
    'pdf',
  ]);
  expect(suggestionsFor('with:', sources).map((entry) => entry.label)).toEqual(
    suggestionsFor('from:', sources).map((entry) => entry.label)
  );
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

test('space: suggests joined spaces by alias and name', () => {
  expect(suggestionsFor('space:', sources).map((entry) => entry.label)).toEqual([
    'Engineering',
    'Social',
  ]);
  expect(suggestionsFor('space:soc', sources).map((entry) => entry.label)).toEqual(['Social']);
});

test('space: falls back to nothing when no spaces are known', () => {
  expect(suggestionsFor('space:', { rooms: [], senders: [] })).toEqual([]);
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
    'poll',
    'pin',
    'pdf',
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

test('a room or space without an alias is inserted by id so a shared name cannot pick another', () => {
  const rooms = [
    { id: '!first:example.org', alias: null, name: 'general', avatarUrl: null },
    { id: '!second:example.org', alias: null, name: 'general', avatarUrl: null },
  ];

  const [, second] = suggestionsFor('in:gen', { rooms, senders: [] });
  expect(second.label).toBe('general');
  expect(second.insert).toBe('in:!second:example.org ');

  const [, social] = suggestionsFor('space:', sources);
  expect(social.label).toBe('Social');
  expect(social.insert).toBe('space:!social:example.org ');
});

test('enter completes a value, but a bare word only once a suggestion was picked', () => {
  expect(enterAccepts('turn on', false)).toBe(false);
  expect(enterAccepts('what is', false)).toBe(false);
  expect(enterAccepts('turn on', true)).toBe(true);
  expect(enterAccepts('has:im', false)).toBe(true);
});
