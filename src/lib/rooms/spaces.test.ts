import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import {
  ancestorSpaceIds,
  childRouting,
  descendantRoomIds,
  inheritedNotificationModes,
  joinedSpaceRooms,
  rootSpaceNames,
  spacesContaining,
  spacesContainingRoom,
} from './spaces';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

function room(overrides: Partial<RoomListItemView>): RoomListItemView {
  return withCounts({
    room_id: '!room:example.org',
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
    room_kind: 'text',
    is_tombstoned: false,
    call_participants: [],
    screen_sharers: [],
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
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

function child(roomId: string) {
  return { room_id: roomId, via: [], order: null, origin_server_ts: 1, suggested: false };
}

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

test('a room takes the mode of its nearest space that sets one', () => {
  const root = room({
    room_id: '!root:example.org',
    room_kind: 'space',
    space_children: [child('!sub:example.org'), child('!top:example.org')],
  });
  const sub = room({
    room_id: '!sub:example.org',
    room_kind: 'space',
    space_children: [child('!deep:example.org'), child('!root:example.org')],
  });
  const other = room({
    room_id: '!other:example.org',
    room_kind: 'space',
    space_children: [child('!top:example.org'), child('!invited:example.org')],
  });
  const rooms = [
    root,
    sub,
    other,
    room({ room_id: '!top:example.org' }),
    room({ room_id: '!deep:example.org' }),
    room({ room_id: '!invited:example.org', state: 'invited' }),
  ];

  expect(
    inheritedNotificationModes(
      rooms,
      new Map([
        ['!root:example.org', 'mute'],
        ['!sub:example.org', 'all'],
        ['!other:example.org', 'mentions'],
      ])
    )
  ).toEqual(
    new Map([
      ['!root:example.org', 'mute'],
      ['!sub:example.org', 'all'],
      ['!other:example.org', 'mentions'],
      ['!top:example.org', 'mute'],
      ['!deep:example.org', 'all'],
    ])
  );
  expect(inheritedNotificationModes(rooms, new Map([['!root:example.org', 'mute']]))).toEqual(
    new Map([
      ['!root:example.org', 'mute'],
      ['!sub:example.org', 'mute'],
      ['!top:example.org', 'mute'],
      ['!deep:example.org', 'mute'],
    ])
  );
});

function bareSpace(roomId: string, children: string[]): RoomListItemView {
  return {
    room_id: roomId,
    room_kind: 'space',
    state: 'joined',
    space_children: children.map((child) => ({ room_id: child })),
  } as unknown as RoomListItemView;
}

test('walks every joined space above the room, farthest first', () => {
  const rooms = [
    bareSpace('!root:example.org', ['!mid:example.org']),
    bareSpace('!mid:example.org', ['!room:example.org']),
  ];
  expect(ancestorSpaceIds(rooms, '!room:example.org')).toEqual([
    '!root:example.org',
    '!mid:example.org',
  ]);
});

test('stops on a cycle', () => {
  const rooms = [
    bareSpace('!a:example.org', ['!b:example.org']),
    bareSpace('!b:example.org', ['!a:example.org']),
  ];
  expect(ancestorSpaceIds(rooms, '!a:example.org')).toEqual(['!b:example.org']);
});

test('walks every joined room and subspace below a space, nearest first', () => {
  const room = (roomId: string) =>
    ({ room_id: roomId, state: 'joined', space_children: [] }) as unknown as RoomListItemView;
  const rooms = [
    bareSpace('!root:example.org', ['!mid:example.org', '!a:example.org', '!gone:example.org']),
    bareSpace('!mid:example.org', ['!b:example.org', '!root:example.org']),
    room('!a:example.org'),
    room('!b:example.org'),
  ];
  expect(descendantRoomIds(rooms, '!root:example.org')).toEqual([
    '!mid:example.org',
    '!a:example.org',
    '!b:example.org',
  ]);
});

test('names the top-level space of each room, through nested spaces and cycles', () => {
  const space = (roomId: string, name: string, children: string[]) =>
    room({
      room_id: roomId,
      name,
      room_kind: 'space',
      space_children: children.map(child),
    });
  const names = rootSpaceNames([
    space('!community:example.org', 'Community', ['!games:example.org']),
    space('!games:example.org', 'Games', ['!general:example.org']),
    space('!other:example.org', 'Other', ['!general-2:example.org']),
    space('!a:example.org', 'A', ['!b:example.org']),
    space('!b:example.org', 'B', ['!a:example.org']),
    room({ room_id: '!loose:example.org' }),
  ]);

  expect(names.get('!general:example.org')).toBe('Community');
  expect(names.get('!games:example.org')).toBe('Community');
  expect(names.get('!general-2:example.org')).toBe('Other');
  expect(names.get('!a:example.org')).toBe('B');
  expect(names.has('!loose:example.org')).toBe(false);
});

test('a space shows voice activity from any joined room under it', () => {
  const caller = { user_id: '@ada:example.org', device_id: 'D', member_id: 'm' } as never;
  const root = room({
    room_id: '!root:example.org',
    room_kind: 'space',
    space_children: [child('!sub:example.org')],
  });
  const sub = room({
    room_id: '!sub:example.org',
    room_kind: 'space',
    space_children: [child('!voice:example.org'), child('!left:example.org')],
  });
  const quiet = room({
    room_id: '!quiet:example.org',
    room_kind: 'space',
    space_children: [child('!left:example.org')],
  });
  const voice = room({ room_id: '!voice:example.org', call_participants: [caller] });
  const left = room({ room_id: '!left:example.org', state: 'left', call_participants: [caller] });
  const live = (candidate: typeof voice) =>
    candidate.state === 'joined' && candidate.call_participants.length > 0;

  expect(spacesContaining([root, quiet], [root, sub, quiet, voice, left], live)).toEqual(
    new Set(['!root:example.org'])
  );
});
