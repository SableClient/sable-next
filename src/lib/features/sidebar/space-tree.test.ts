import { expect, test } from 'vitest';

import type { RoomListItemView, SpaceTreeNodeView } from '#src/generated/protocol';

import { flattenSpaceTree, spaceTreeNodes, type SpaceTreeNode } from './space-tree';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return withCounts({
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
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

function space(roomId: string, children: string[]): RoomListItemView {
  return room(roomId, {
    room_kind: 'space',
    space_children: children.map((child, index) => ({
      room_id: child,
      via: [],
      order: null,
      origin_server_ts: index,
      suggested: false,
    })),
  });
}

function byId(rooms: RoomListItemView[]): (roomId: string) => RoomListItemView | undefined {
  const rows = new Map(rooms.map((entry) => [entry.room_id, entry]));
  return (roomId) => rows.get(roomId);
}

function node(path: string, depth: number, children?: SpaceTreeNodeView[]): SpaceTreeNodeView {
  const room_id = path.split('/').at(-1) ?? path;
  const key = `root/${path}`;
  if (children === undefined) return { kind: 'room', room_id, key, depth };
  return { kind: 'category', room_id, key, depth, children };
}

function link(path: string, depth: number): SpaceTreeNodeView {
  return { kind: 'link', room_id: path.split('/').at(-1) ?? path, key: `root/${path}`, depth };
}

function describe(rows: readonly SpaceTreeNode[]): string[] {
  return rows.map((row) => {
    const threads = row.threads.map((thread) => `${thread.kind}@${String(thread.level)}`);
    return [row.kind, row.room.room_id, String(row.depth), ...threads].join(' ');
  });
}

const open = { closed: () => false, keep: () => true };

const rooms = [
  space('root', ['a', 's1']),
  space('s1', ['b', 's2']),
  space('s2', ['c', 'd', 's3']),
  space('s3', ['e', 's4']),
  space('s4', ['f']),
  room('a'),
  room('b'),
  room('c'),
  room('d'),
  room('e'),
  room('f'),
];

const shallow = [
  node('a', 0),
  node('s1', 0, [
    node('s1/b', 0),
    node('s1/s2', 0, [node('s1/s2/c', 1), node('s1/s2/d', 1), link('s1/s2/s3', 1)]),
  ]),
];

const deep = [
  node('a', 0),
  node('s1', 0, [
    node('s1/b', 0),
    node('s1/s2', 0, [
      node('s1/s2/c', 1),
      node('s1/s2/d', 1),
      node('s1/s2/s3', 1, [
        node('s1/s2/s3/e', 2),
        node('s1/s2/s3/s4', 2, [node('s1/s2/s3/s4/f', 3)]),
      ]),
    ]),
  ]),
];

test('threads the children of a second-level subspace and ends at a link', () => {
  const tree = spaceTreeNodes(shallow, 'root', byId(rooms));

  expect(describe(flattenSpaceTree(tree, open))).toEqual([
    'room a 0',
    'category s1 0',
    'room b 0',
    'category s2 0',
    'room c 1 branch@0',
    'room d 1 branch@0',
    'link s3 1 last@0',
  ]);
});

test('a deeper tree carries the thread through the grandchildren', () => {
  const tree = spaceTreeNodes(deep, 'root', byId(rooms));

  expect(describe(flattenSpaceTree(tree, open))).toEqual([
    'room a 0',
    'category s1 0',
    'room b 0',
    'category s2 0',
    'room c 1 branch@0',
    'room d 1 branch@0',
    'category s3 1 last@0',
    'room e 2 branch@1',
    'category s4 2 last@1',
    'room f 3 last@2',
  ]);
});

test('a thread keeps running past a sibling subspace that has children of its own', () => {
  const nested = [
    space('root', ['s1']),
    space('s1', ['s2']),
    space('s2', ['s3', 'x']),
    space('s3', ['y']),
    room('x'),
    room('y'),
  ];
  const view = [
    node('s1', 0, [
      node('s1/s2', 0, [node('s1/s2/x', 1), node('s1/s2/s3', 1, [node('s1/s2/s3/y', 2)])]),
    ]),
  ];

  expect(describe(flattenSpaceTree(spaceTreeNodes(view, 'root', byId(nested)), open))).toEqual([
    'category s1 0',
    'category s2 0',
    'room x 1 branch@0',
    'category s3 1 last@0',
    'room y 2 last@1',
  ]);
});

test('a closed subspace still shows the rooms it keeps, and the subspaces leading to them', () => {
  const tree = spaceTreeNodes(deep, 'root', byId(rooms));
  const rows = flattenSpaceTree(tree, {
    closed: (key) => key === 'root/s1',
    keep: (row) => row.roomId === 'e',
  });

  expect(describe(rows)).toEqual([
    'room a 0',
    'category s1 0',
    'category s2 0',
    'category s3 1 last@0',
    'room e 2 last@1',
  ]);
});

test('nodes whose room left the list are dropped with their children', () => {
  const tree = spaceTreeNodes(
    shallow,
    'root',
    byId(rooms.filter((entry) => entry.room_id !== 's1'))
  );

  expect(describe(flattenSpaceTree(tree, open))).toEqual(['room a 0']);
});
