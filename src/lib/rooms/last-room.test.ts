import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { roomView } from '#lib/test-support/room-views.js';

import { HOME_SECTION, restoredRoomPath } from './last-room';

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return roomView({
    room_id: roomId,
    name: roomId,
    join_rule: 'public',
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    ...overrides,
  });
}

const space = room('!space:example.org', {
  room_kind: 'space',
  space_children: [
    { room_id: '!room:example.org', via: [], order: null, suggested: false, origin_server_ts: 0 },
  ],
});
const other = room('!other:example.org', { room_kind: 'space' });
const rooms = [space, other, room('!room:example.org')];

test('keeps the canonical space when no section was stored', () => {
  expect(restoredRoomPath(rooms, '!room:example.org', null, true)).toBe(
    '/space/!space%3Aexample.org/!room%3Aexample.org'
  );
});

test('restores the Home tab a room was opened from', () => {
  expect(restoredRoomPath(rooms, '!room:example.org', HOME_SECTION, true)).toBe(
    '/home/!room%3Aexample.org'
  );
});

test('falls back when Home is disabled', () => {
  expect(restoredRoomPath(rooms, '!room:example.org', HOME_SECTION, false)).toBe(
    '/space/!space%3Aexample.org/!room%3Aexample.org'
  );
});

test('restores the space a room was opened from', () => {
  const second = room('!second:example.org', {
    room_kind: 'space',
    space_children: [
      { room_id: '!room:example.org', via: [], order: null, suggested: false, origin_server_ts: 0 },
    ],
  });
  expect(restoredRoomPath([second, ...rooms], '!room:example.org', second.room_id, true)).toBe(
    '/space/!second%3Aexample.org/!room%3Aexample.org'
  );
});

test('falls back when the stored space no longer contains the room', () => {
  expect(restoredRoomPath(rooms, '!room:example.org', other.room_id, true)).toBe(
    '/space/!space%3Aexample.org/!room%3Aexample.org'
  );
});
