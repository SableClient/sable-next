import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import {
  filterRoomsByQuery,
  parentSpaceNames,
  parseJumpQuery,
  unreadRoomAtOffset,
  unreadRoomsByPriority,
} from './room-jump';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

function room(overrides: Partial<RoomListItemView> & { room_id: string }): RoomListItemView {
  return withCounts({
    canonical_alias: null,
    name: null,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_tombstoned: false,
    call_participants: [],
    screen_sharers: [],
    room_kind: 'text',
    supports_knock: false,
    supports_restricted: false,
    supports_knock_restricted: false,
    space_children: [],
    bridge: null,
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  });
}

function latest(timestamp: number): RoomListItemView['latest_event'] {
  return { sender: null, body: '', timestamp, sending: false, event_id: null };
}

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

test('unread navigation skips read rooms and wraps in both directions', () => {
  const rooms = [
    room({ room_id: '!a:example.org', unread: 1 }),
    room({ room_id: '!b:example.org' }),
    room({ room_id: '!c:example.org', unread: 2 }),
  ];

  expect(unreadRoomAtOffset(rooms, '!a:example.org', 1)?.room_id).toBe('!c:example.org');
  expect(unreadRoomAtOffset(rooms, '!c:example.org', 1)?.room_id).toBe('!a:example.org');
  expect(unreadRoomAtOffset(rooms, '!c:example.org', -1)?.room_id).toBe('!a:example.org');
  expect(unreadRoomAtOffset(rooms, '!a:example.org', -1)?.room_id).toBe('!c:example.org');
});

test('unread navigation starts from the current room after it becomes read', () => {
  const rooms = [
    room({ room_id: '!a:example.org', unread: 1 }),
    room({ room_id: '!b:example.org', unread: 1 }),
    room({ room_id: '!c:example.org', unread: 1 }),
  ];
  expect(unreadRoomAtOffset(rooms, '!a:example.org', 1)?.room_id).toBe('!b:example.org');
  rooms[1] = room({ room_id: '!b:example.org' });

  expect(unreadRoomAtOffset(rooms, '!b:example.org', 1)?.room_id).toBe('!c:example.org');
  expect(unreadRoomAtOffset(rooms, '!b:example.org', -1)?.room_id).toBe('!a:example.org');
});

test('unread navigation includes rooms marked unread and direct messages', () => {
  const rooms = [
    room({ room_id: '!a:example.org' }),
    room({ room_id: '!b:example.org', marked_unread: true, is_direct: true }),
  ];

  expect(unreadRoomAtOffset(rooms, '!a:example.org', 1)?.room_id).toBe('!b:example.org');
});

test('unread navigation skips spaces and rooms that are not joined', () => {
  const rooms = [
    room({ room_id: '!space:example.org', room_kind: 'space', unread: 3 }),
    room({ room_id: '!invite:example.org', state: 'invited', unread: 2 }),
    room({ room_id: '!left:example.org', state: 'left', unread: 1 }),
    room({ room_id: '!joined:example.org', unread: 1 }),
  ];

  expect(unreadRoomAtOffset(rooms, null, 1)?.room_id).toBe('!joined:example.org');
});

test('unread navigation starts at either end when no room is open', () => {
  const rooms = [
    room({ room_id: '!a:example.org', unread: 1 }),
    room({ room_id: '!b:example.org', unread: 1 }),
  ];

  expect(unreadRoomAtOffset(rooms, null, 1)?.room_id).toBe('!a:example.org');
  expect(unreadRoomAtOffset(rooms, null, -1)?.room_id).toBe('!b:example.org');
});

test('unread navigation stays put when no other room is unread', () => {
  const rooms = [room({ room_id: '!a:example.org', unread: 1 })];

  expect(unreadRoomAtOffset(rooms, '!a:example.org', 1)).toBeNull();
  expect(unreadRoomAtOffset([], null, -1)).toBeNull();
});

test('parseJumpQuery reads the type prefix off the query', () => {
  expect(parseJumpQuery('#eng')).toEqual({ kind: 'room', text: 'eng' });
  expect(parseJumpQuery('*design')).toEqual({ kind: 'space', text: 'design' });
  expect(parseJumpQuery(' @bob')).toEqual({ kind: 'direct', text: 'bob' });
  expect(parseJumpQuery('eng')).toEqual({ kind: null, text: 'eng' });
  expect(parseJumpQuery('#')).toEqual({ kind: 'room', text: '' });
});

test('filterRoomsByQuery keeps only the prefixed kind', () => {
  const rooms = [
    room({ room_id: '!a:example.org', name: 'Design', room_kind: 'space' }),
    room({ room_id: '!b:example.org', name: 'Design chat' }),
    room({ room_id: '!c:example.org', name: 'Designer', is_direct: true }),
  ];

  expect(filterRoomsByQuery(rooms, '*desi').map((r) => r.room_id)).toEqual(['!a:example.org']);
  expect(filterRoomsByQuery(rooms, '#desi').map((r) => r.room_id)).toEqual(['!b:example.org']);
  expect(filterRoomsByQuery(rooms, '@desi').map((r) => r.room_id)).toEqual(['!c:example.org']);
});

test('an empty query keeps the room list order, without spaces', () => {
  const rooms = [
    room({ room_id: '!b:example.org' }),
    room({ room_id: '!c:example.org', room_kind: 'space' }),
    room({ room_id: '!d:example.org', latest_event: latest(20) }),
    room({ room_id: '!a:example.org', latest_event: latest(30) }),
  ];

  expect(filterRoomsByQuery(rooms, '').map((r) => r.room_id)).toEqual([
    '!b:example.org',
    '!d:example.org',
    '!a:example.org',
  ]);
});

test('an empty spaces query still lists spaces', () => {
  const rooms = [
    room({ room_id: '!a:example.org' }),
    room({ room_id: '!b:example.org', room_kind: 'space' }),
  ];

  expect(filterRoomsByQuery(rooms, '*').map((r) => r.room_id)).toEqual(['!b:example.org']);
});

test('parentSpaceNames names a room after the first space that lists it', () => {
  const rooms = [
    room({
      room_id: '!space:example.org',
      name: 'Engineering',
      room_kind: 'space',
      space_children: [
        { room_id: '!a:example.org', via: [], order: null, suggested: false, origin_server_ts: 0 },
      ],
    }),
    room({ room_id: '!a:example.org', name: 'Backend' }),
  ];

  expect(parentSpaceNames(rooms).get('!a:example.org')).toBe('Engineering');
});
