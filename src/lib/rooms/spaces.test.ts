import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import {
  childRouting,
  joinedSpaceRooms,
  quietRoomIds,
  spacesContainingRoom,
  spaceUnreadTotals,
} from './spaces';
import { withCounts } from '#lib/rooms/summary-fixtures.js';
import { quietUnread, roomUnread } from './unread';

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
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  });
}

test('does not mark a space unread for a muted child room', () => {
  const space = room({
    room_id: '!space:example.org',
    room_kind: 'space',
    space_children: [
      {
        room_id: '!muted:example.org',
        via: [],
        order: null,
        origin_server_ts: 1,
        suggested: false,
      },
    ],
  });
  const muted = room({
    room_id: '!muted:example.org',
    unread: 3,
    notification: { room: 'mute', default: 'all' },
  });

  expect(spaceUnreadTotals([space], [space, muted], roomUnread)).toEqual(new Map());
});

test('sums the mentions of a space across its nested rooms, counting each room once', () => {
  const root = room({
    room_id: '!root:example.org',
    room_kind: 'space',
    space_children: [
      { room_id: '!sub:example.org', via: [], order: null, origin_server_ts: 1, suggested: false },
      {
        room_id: '!shared:example.org',
        via: [],
        order: null,
        origin_server_ts: 1,
        suggested: false,
      },
    ],
  });
  const sub = room({
    room_id: '!sub:example.org',
    room_kind: 'space',
    space_children: [
      { room_id: '!deep:example.org', via: [], order: null, origin_server_ts: 1, suggested: false },
      {
        room_id: '!shared:example.org',
        via: [],
        order: null,
        origin_server_ts: 1,
        suggested: false,
      },
    ],
  });
  const deep = room({ room_id: '!deep:example.org', unread: 4, notifying: 4, highlight: 1 });
  const shared = room({ room_id: '!shared:example.org', unread: 2, notifying: 2, highlight: 2 });

  expect(spaceUnreadTotals([root, sub], [root, sub, deep, shared], roomUnread)).toEqual(
    new Map([
      ['!root:example.org', { unread: 6, highlight: 3, marked: false, notifying: 6 }],
      ['!sub:example.org', { unread: 6, highlight: 3, marked: false, notifying: 6 }],
    ])
  );
});

test('a hand-marked room dots its parent space, even muted', () => {
  const root = room({
    room_id: '!root:example.org',
    room_kind: 'space',
    space_children: [
      {
        room_id: '!muted:example.org',
        via: [],
        order: null,
        origin_server_ts: 1,
        suggested: false,
      },
    ],
  });
  const muted = room({
    room_id: '!muted:example.org',
    marked_unread: true,
    notification: { room: 'mute', default: 'all' },
  });

  expect(spaceUnreadTotals([root], [root, muted], roomUnread)).toEqual(
    new Map([['!root:example.org', { unread: 0, highlight: 0, marked: true, notifying: 0 }]])
  );
});

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

test('a mentions-only child still marks its space unread', () => {
  const space = room({
    room_id: '!space:example.org',
    room_kind: 'space',
    space_children: [
      {
        room_id: '!quiet:example.org',
        via: [],
        order: null,
        origin_server_ts: 1,
        suggested: false,
      },
    ],
  });
  const quiet = room({ room_id: '!quiet:example.org', unread: 5, highlight: 0 });

  expect(spaceUnreadTotals([space], [space, quiet], roomUnread)).toEqual(
    new Map([['!space:example.org', { unread: 5, highlight: 0, marked: false, notifying: 0 }]])
  );
});

test('a space totals how much of its unread notified', () => {
  const space = room({
    room_id: '!space:example.org',
    room_kind: 'space',
    space_children: [
      { room_id: '!loud:example.org', via: [], order: null, origin_server_ts: 1, suggested: false },
      {
        room_id: '!quiet:example.org',
        via: [],
        order: null,
        origin_server_ts: 2,
        suggested: false,
      },
    ],
  });
  const loud = room({ room_id: '!loud:example.org', unread: 4, notifying: 4 });
  const quiet = room({ room_id: '!quiet:example.org', unread: 5 });
  const totals = spaceUnreadTotals([space], [space, loud, quiet], roomUnread).get(
    '!space:example.org'
  );

  expect(totals?.unread).toBe(9);
  expect(totals?.notifying).toBe(4);
});

function child(roomId: string) {
  return { room_id: roomId, via: [], order: null, origin_server_ts: 1, suggested: false };
}

test('a hidden space hides the unread of every room beneath it', () => {
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
  const rooms = [
    root,
    sub,
    room({ room_id: '!top:example.org' }),
    room({ room_id: '!deep:example.org' }),
  ];

  expect(quietRoomIds(rooms, ['!sub:example.org'])).toEqual(
    new Set(['!sub:example.org', '!deep:example.org', '!root:example.org', '!top:example.org'])
  );
  expect(quietRoomIds(rooms, ['!top:example.org'])).toEqual(new Set(['!top:example.org']));
});

test('a hidden room adds only its mentions to its space', () => {
  const space = room({
    room_id: '!space:example.org',
    room_kind: 'space',
    space_children: [child('!quiet:example.org')],
  });
  const quiet = room({ room_id: '!quiet:example.org', unread: 5, notifying: 5 });
  const mentioned = room({ room_id: '!quiet:example.org', unread: 5, notifying: 5, highlight: 1 });
  const hidden = new Set([quiet.room_id]);

  const unreadFor = (candidate: RoomListItemView) => {
    const loud = roomUnread(candidate);
    return hidden.has(candidate.room_id) ? quietUnread(loud) : loud;
  };

  expect(spaceUnreadTotals([space], [space, quiet], unreadFor)).toEqual(new Map());
  expect(spaceUnreadTotals([space], [space, mentioned], unreadFor).get(space.room_id)).toEqual({
    unread: 1,
    highlight: 1,
    marked: false,
    notifying: 0,
  });
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
