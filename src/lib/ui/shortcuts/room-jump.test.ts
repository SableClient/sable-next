import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';

import { filterRoomsByQuery, roomDisplayName, unreadRoomsByPriority } from './room-jump';

function room(overrides: Partial<RoomSummary> & { room_id: string }): RoomSummary {
  return {
    canonical_alias: null,
    name: null,
    topic: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: false,
    is_tombstoned: false,
    is_voice: false,
    call_participants: [],
    has_space_parent: false,
    supports_knock: false,
    supports_restricted: false,
    supports_knock_restricted: false,
    space_children: [],
    unread: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  };
}

test('roomDisplayName prefers the name, then the alias, then the id', () => {
  expect(roomDisplayName(room({ room_id: '!a:example.org', name: 'Engineering' }))).toBe(
    'Engineering'
  );
  expect(
    roomDisplayName(room({ room_id: '!a:example.org', canonical_alias: '#eng:example.org' }))
  ).toBe('#eng:example.org');
  expect(roomDisplayName(room({ room_id: '!a:example.org' }))).toBe('!a:example.org');
});

test('filterRoomsByQuery excludes rooms that are not joined', () => {
  const rooms = [
    room({ room_id: '!a:example.org', name: 'Invited', state: 'invited' }),
    room({ room_id: '!b:example.org', name: 'Joined' }),
  ];

  expect(filterRoomsByQuery(rooms, '').map((r) => r.room_id)).toEqual(['!b:example.org']);
});

test('filterRoomsByQuery ranks rooms by fuzzy match against the display name', () => {
  const rooms = [
    room({ room_id: '!a:example.org', name: 'Random chat' }),
    room({ room_id: '!b:example.org', name: 'Engineering' }),
  ];

  expect(filterRoomsByQuery(rooms, 'eng').map((r) => r.room_id)).toEqual(['!b:example.org']);
});

test('filterRoomsByQuery respects the limit', () => {
  const rooms = [
    room({ room_id: '!a:example.org', name: 'Room A' }),
    room({ room_id: '!b:example.org', name: 'Room B' }),
    room({ room_id: '!c:example.org', name: 'Room C' }),
  ];

  expect(filterRoomsByQuery(rooms, '', 2)).toHaveLength(2);
});

test('unreadRoomsByPriority drops read rooms and the excluded room', () => {
  const rooms = [
    room({ room_id: '!a:example.org', unread: 0 }),
    room({ room_id: '!b:example.org', unread: 3 }),
    room({ room_id: '!c:example.org', unread: 1 }),
  ];

  expect(unreadRoomsByPriority(rooms, '!c:example.org').map((r) => r.room_id)).toEqual([
    '!b:example.org',
  ]);
});

test('unreadRoomsByPriority ranks highlights above plain unread counts', () => {
  const rooms = [
    room({ room_id: '!a:example.org', unread: 10, highlight: 0 }),
    room({ room_id: '!b:example.org', unread: 1, highlight: 1 }),
  ];

  expect(unreadRoomsByPriority(rooms, null).map((r) => r.room_id)).toEqual([
    '!b:example.org',
    '!a:example.org',
  ]);
});

test('unreadRoomsByPriority breaks a highlight tie on unread count', () => {
  const rooms = [
    room({ room_id: '!a:example.org', unread: 2, highlight: 1 }),
    room({ room_id: '!b:example.org', unread: 5, highlight: 1 }),
  ];

  expect(unreadRoomsByPriority(rooms, null).map((r) => r.room_id)).toEqual([
    '!b:example.org',
    '!a:example.org',
  ]);
});
