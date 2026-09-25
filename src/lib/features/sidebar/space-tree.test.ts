import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

import { flattenSpaceTree, spaceTree, type SpaceTreeNode } from './space-tree';

function room(roomId: string, overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
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
    room_type: null,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  };
}

function space(roomId: string, children: string[]): RoomSummary {
  return room(roomId, {
    is_space: true,
    space_children: children.map((child, index) => ({
      room_id: child,
      via: [],
      order: null,
      origin_server_ts: index,
      suggested: false,
    })),
  });
}

function byId(rooms: RoomSummary[]): Map<string, RoomSummary> {
  return new Map(rooms.map((entry) => [entry.room_id, entry]));
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

test('nests subspaces as v1 does and threads the children of a second-level subspace', () => {
  const tree = spaceTree(rooms[0], byId(rooms), 3);

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

test('a deeper limit keeps nesting and carries the thread through the grandchildren', () => {
  const tree = spaceTree(rooms[0], byId(rooms), 5);

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
  const tree = spaceTree(nested[0], byId(nested), 6);

  expect(describe(flattenSpaceTree(tree, open))).toEqual([
    'category s1 0',
    'category s2 0',
    'room x 1 branch@0',
    'category s3 1 last@0',
    'room y 2 last@1',
  ]);
});

test('a subspace holding no joined room is left out', () => {
  const sparse = [
    space('root', ['empty', 'full']),
    space('empty', []),
    space('full', ['r']),
    room('r'),
  ];

  expect(describe(flattenSpaceTree(spaceTree(sparse[0], byId(sparse), 3), open))).toEqual([
    'category full 0',
    'room r 0',
  ]);
});

test('a closed subspace still shows the rooms it keeps, and the subspaces leading to them', () => {
  const tree = spaceTree(rooms[0], byId(rooms), 5);
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

test('a cycle between spaces does not recurse forever', () => {
  const cyclic = [space('root', ['s1']), space('s1', ['root', 'r']), room('r')];

  expect(describe(flattenSpaceTree(spaceTree(cyclic[0], byId(cyclic), 3), open))).toEqual([
    'category s1 0',
    'room r 0',
  ]);
});
