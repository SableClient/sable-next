import { expect, test } from 'vitest';

import type { RoomListItemView, RoomTag } from '#src/generated/protocol';

import { isFavourite, roomComparator, roomRow, treeRows, withoutFavourites } from './nav-rows.js';
import type { SpaceTreeNode, SpaceTreeRoom, SpaceTreeSpace } from './space-tree.js';

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return {
    room_id: roomId,
    tags: [],
    latest_event: null,
    ...overrides,
  } as unknown as RoomListItemView;
}

function leaf(roomId: string, tags: RoomTag[] = []): SpaceTreeRoom {
  return {
    kind: 'room',
    room: room(roomId, { tags }),
    roomId,
    parentSpaceId: '!space',
    depth: 0,
    key: roomId,
    threads: [],
  };
}

function group(
  roomId: string,
  children: SpaceTreeNode[],
  kind: SpaceTreeSpace['kind'] = 'category'
): SpaceTreeSpace {
  return { kind, room: room(roomId), depth: 0, key: roomId, threads: [], children };
}

test('a room keeps the same row while its summary object is unchanged', () => {
  const summary = room('!a');

  expect(roomRow(summary)).toBe(roomRow(summary));
  expect(roomRow(summary)).toEqual({
    room: summary,
    roomId: '!a',
    depth: 0,
    kind: 'room',
    key: '!a',
  });
  expect(roomRow(room('!a'))).not.toBe(roomRow(summary));
});

test('recent follows the core list order, not the latest event', () => {
  const rows = [
    roomRow(room('!old', { latest_event: { timestamp: 1 } as RoomListItemView['latest_event'] })),
    roomRow(room('!unlisted')),
    roomRow(room('!none')),
    roomRow(room('!new', { latest_event: { timestamp: 5 } as RoomListItemView['latest_event'] })),
  ];
  const listOrder = new Map([
    ['!none', 0],
    ['!new', 1],
    ['!old', 2],
  ]);

  expect(rows.sort(roomComparator('recent', listOrder)).map((row) => row.roomId)).toEqual([
    '!none',
    '!new',
    '!old',
    '!unlisted',
  ]);
});

test('a row is a favourite only when its room carries the tag', () => {
  expect(isFavourite(leaf('!a', ['favourite']))).toBe(true);
  expect(isFavourite(leaf('!b'))).toBe(false);
  expect(isFavourite({ roomId: '!c', depth: 0, kind: 'room', key: '!c' })).toBe(false);
});

test('tree rows lists every nested room in order', () => {
  const tree = [leaf('!a'), group('!s', [leaf('!b'), group('!t', [leaf('!c')])]), leaf('!d')];

  expect(treeRows(tree).map((row) => row.roomId)).toEqual(['!a', '!b', '!c', '!d']);
});

test('removing favourites drops emptied categories but keeps links', () => {
  const tree = [
    leaf('!fav', ['favourite']),
    group('!only-favs', [leaf('!fav2', ['favourite'])]),
    group('!mixed', [leaf('!fav3', ['favourite']), leaf('!plain')]),
    group('!link', [], 'link'),
  ];

  const kept = withoutFavourites(tree);

  expect(kept.map((item) => item.key)).toEqual(['!mixed', '!link']);
  const mixed = kept[0] as SpaceTreeSpace;
  expect(mixed.children.map((item) => item.key)).toEqual(['!plain']);
  expect(tree[2]).not.toBe(mixed);
});

test('rooms sort by name ignoring case, or by recency', () => {
  const rows = [
    roomRow(room('!b', { name: 'bravo' })),
    roomRow(room('!a', { name: 'Alpha' })),
    roomRow(room('!c', { name: 'charlie' })),
  ];
  const listOrder = new Map([
    ['!b', 0],
    ['!c', 1],
    ['!a', 2],
  ]);
  const order = (sort: Parameters<typeof roomComparator>[0]): string[] =>
    [...rows].sort(roomComparator(sort, listOrder)).map((row) => row.roomId);

  expect(order('name-asc')).toEqual(['!a', '!b', '!c']);
  expect(order('name-desc')).toEqual(['!c', '!b', '!a']);
  expect(order('recent')).toEqual(['!b', '!c', '!a']);
});
