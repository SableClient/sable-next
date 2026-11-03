import { expect, test } from 'vitest';

import type { SearchDirectory, SearchRoom, SpaceChildEdge } from '#src/generated/protocol';

import { parseSearchQuery, resolveSearchQuery } from './search-query';

function edge(roomId: string): SpaceChildEdge {
  return { room_id: roomId, via: [], order: null, origin_server_ts: 0, suggested: false };
}

function room(roomId: string, name: string, fields: Partial<SearchRoom> = {}): SearchRoom {
  return {
    room_id: roomId,
    name,
    canonical_alias: null,
    joined: true,
    is_tombstoned: false,
    is_space: false,
    is_direct: false,
    direct_targets: [],
    space_children: [],
    ...fields,
  };
}

const directory: SearchDirectory = {
  rooms: [
    room('!dev:example.org', 'dev'),
    room('!ops:example.org', 'ops'),
    room('!eng:example.org', 'eng', {
      is_space: true,
      space_children: [edge('!dev:example.org'), edge('!ops:example.org')],
    }),
    room('!new:example.org', 'new', { is_space: true }),
    room('!dm:example.org', 'Kris', { is_direct: true, direct_targets: ['@kris:example.org'] }),
  ],
  people: [
    { user_id: '@kris:example.org', display_name: 'Kris' },
    { user_id: '@meow:example.org', display_name: 'Meow' },
    { user_id: '@meowmeow:example.org', display_name: 'Meow Meow' },
    { user_id: '@bark:example.org', display_name: 'Bark' },
  ],
};

function resolveFor(query: string) {
  return resolveSearchQuery(query, directory);
}

test('the wasm binding parses a query into text, tokens and phrases across JSON', () => {
  const parsed = parseSearchQuery('deploy from:kris "pipeline is broken" -staging');

  expect(parsed.text).toBe('deploy');
  expect(parsed.phrases).toEqual(['pipeline is broken']);
  expect(parsed.exclude).toEqual(['staging']);
  expect(
    parsed.tokens.map(({ operator, value, negated }) => ({ operator, value, negated }))
  ).toEqual([{ operator: 'from', value: 'kris', negated: false }]);
});

test('the wasm binding resolves names against the directory and reports the rest', () => {
  const { filter, unresolved } = resolveFor('from:kris in:eng from:nobody');

  expect(filter.senders).toEqual(['@kris:example.org']);
  expect(filter.rooms).toEqual(['!dev:example.org', '!ops:example.org']);
  expect(unresolved.map((token) => token.value)).toEqual(['nobody']);
});

test('date bounds use the local start of day from the JavaScript clock', () => {
  const { filter } = resolveFor('after:2026-01-01 before:2026-02-01');
  const day = resolveFor('on:2026-03-15').filter;

  expect(filter.after_ts).toBe(Date.parse('2026-01-01T00:00:00'));
  expect(filter.before_ts).toBe(Date.parse('2026-02-01T00:00:00'));
  expect(day.after_ts).toBe(Date.parse('2026-03-15T00:00:00'));
  expect(day.before_ts).toBe(Date.parse('2026-03-16T00:00:00') - 1);
});
