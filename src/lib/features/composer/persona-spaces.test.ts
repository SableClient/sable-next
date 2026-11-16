import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { roomSpaces } from '#lib/model/model.js';

import { personaSpaces } from './persona-spaces.js';

function space(roomId: string, children: string[]): RoomListItemView {
  return {
    room_id: roomId,
    canonical_alias: null,
    room_kind: 'space',
    state: 'joined',
    space_children: children.map((child) => ({
      room_id: child,
      via: [],
      order: null,
      origin_server_ts: 0,
      suggested: false,
    })),
  } as unknown as RoomListItemView;
}

const rooms = [
  space('!root:example.org', ['!mid:example.org']),
  space('!mid:example.org', ['!room:example.org']),
  space('!other:example.org', ['!room:example.org']),
];

const spacesById = new Map(roomSpaces(rooms).map((entry) => [entry.room_id, entry]));
const roomList = { rooms, roomSpaces: (roomId: string) => spacesById.get(roomId) };

test('orders the spaces nearest first and targets the direct parent outside a space', () => {
  expect(personaSpaces(roomList, '!room:example.org', undefined)).toEqual({
    target: '!mid:example.org',
    order: ['!mid:example.org', '!other:example.org', '!root:example.org'],
  });
});

test('targets the sidebar space and ranks it first among its level', () => {
  expect(personaSpaces(roomList, '!room:example.org', '!root:example.org')).toEqual({
    target: '!root:example.org',
    order: ['!mid:example.org', '!other:example.org', '!root:example.org'],
  });
  expect(personaSpaces(roomList, '!room:example.org', '!other:example.org')).toEqual({
    target: '!other:example.org',
    order: ['!other:example.org', '!mid:example.org', '!root:example.org'],
  });
});

test('ignores a sidebar space the room is not in', () => {
  expect(personaSpaces(roomList, '!mid:example.org', '!other:example.org')).toEqual({
    target: '!root:example.org',
    order: ['!root:example.org'],
  });
  expect(personaSpaces(roomList, '!lonely:example.org', '!root:example.org')).toEqual({
    target: null,
    order: [],
  });
});
