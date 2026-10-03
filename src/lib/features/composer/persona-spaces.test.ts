import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

import { personaSpaces } from './persona-spaces.js';

function space(roomId: string, children: string[]): RoomSummary {
  return {
    room_id: roomId,
    canonical_alias: null,
    is_space: true,
    state: 'joined',
    space_children: children.map((child) => ({ room_id: child })),
  } as unknown as RoomSummary;
}

const rooms = [
  space('!root:example.org', ['!mid:example.org']),
  space('!mid:example.org', ['!room:example.org']),
  space('!other:example.org', ['!room:example.org']),
];

test('orders the spaces nearest first and targets the direct parent outside a space', () => {
  expect(personaSpaces(rooms, '!room:example.org', undefined)).toEqual({
    target: '!mid:example.org',
    order: ['!mid:example.org', '!other:example.org', '!root:example.org'],
  });
});

test('targets the sidebar space and ranks it first among its level', () => {
  expect(personaSpaces(rooms, '!room:example.org', '!root:example.org')).toEqual({
    target: '!root:example.org',
    order: ['!mid:example.org', '!other:example.org', '!root:example.org'],
  });
  expect(personaSpaces(rooms, '!room:example.org', '!other:example.org')).toEqual({
    target: '!other:example.org',
    order: ['!other:example.org', '!mid:example.org', '!root:example.org'],
  });
});

test('ignores a sidebar space the room is not in', () => {
  expect(personaSpaces(rooms, '!mid:example.org', '!other:example.org')).toEqual({
    target: '!root:example.org',
    order: ['!root:example.org'],
  });
  expect(personaSpaces(rooms, '!lonely:example.org', '!root:example.org')).toEqual({
    target: null,
    order: [],
  });
});
