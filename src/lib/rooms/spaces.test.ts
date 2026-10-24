import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { childRouting, joinedSpaceRooms, spacesContainingRoom } from './spaces';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

function room(overrides: Partial<RoomListItemView>): RoomListItemView {
  return withCounts({
    room_id: '!room:example.org',
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
    room_kind: 'text',
    is_tombstoned: false,
    call_participants: [],
    screen_sharers: [],
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  });
}

test('a joined space lends its edge to a room opened from a link', () => {
  const space = room({
    room_id: '!space:example.org',
    room_kind: 'space',
    space_children: [
      {
        room_id: '!child',
        via: ['remote.example'],
        order: null,
        origin_server_ts: 1,
        suggested: false,
      },
    ],
  });

  expect(childRouting([space], '!child')).toEqual({
    via: ['remote.example'],
    parentId: '!space:example.org',
  });
  expect(childRouting([space], '!absent')).toEqual({ via: [], parentId: null });
});

test('finds the space holding a call room through a nested space, with cycles', () => {
  const child = (roomId: string) => ({
    room_id: roomId,
    via: [],
    order: null,
    origin_server_ts: 1,
    suggested: false,
  });
  const root = room({
    room_id: '!root:example.org',
    room_kind: 'space',
    space_children: [child('!sub:example.org')],
  });
  const sub = room({
    room_id: '!sub:example.org',
    room_kind: 'space',
    space_children: [child('!root:example.org'), child('!voice:example.org')],
  });
  const other = room({ room_id: '!other:example.org', room_kind: 'space', space_children: [] });
  const voice = room({ room_id: '!voice:example.org' });
  const rooms = [root, sub, other, voice];

  expect(spacesContainingRoom([root, other], rooms, '!voice:example.org')).toEqual(
    new Set(['!root:example.org'])
  );
  expect(spacesContainingRoom([root, other], rooms, null)).toEqual(new Set());
  expect(spacesContainingRoom([root, other], rooms, '!elsewhere:example.org')).toEqual(new Set());
});

test('collects joined rooms from nested spaces once, skipping unjoined children', () => {
  const edges = (...ids: string[]) =>
    ids.map((room_id) => ({
      room_id,
      via: [],
      order: null,
      origin_server_ts: 1,
      suggested: false,
    }));
  const rooms = [
    room({ room_id: '!root:x', room_kind: 'space', space_children: edges('!a:x', '!sub:x') }),
    room({
      room_id: '!sub:x',
      room_kind: 'space',
      space_children: edges('!b:x', '!root:x', '!left:x', '!a:x'),
    }),
    room({ room_id: '!a:x' }),
    room({ room_id: '!b:x' }),
    room({ room_id: '!left:x', state: 'left' }),
  ];
  const byId = (id: string) => rooms.find((candidate) => candidate.room_id === id);

  expect(joinedSpaceRooms(rooms[0], byId)).toEqual(['!a:x', '!b:x']);
  expect(joinedSpaceRooms(undefined, byId)).toEqual([]);
});
