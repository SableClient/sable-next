import { expect, test } from 'vitest';

import type { DropEdge } from '#lib/ui/drag-list.js';

import { dropIndex, orderBetween, orderKeys, reorderChildren, sortEdges } from './space-order';

type Child = { roomId: string; order: string | null };

function child(roomId: string, order: string | null): Child {
  return { roomId, order };
}

function must<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

function ascending(orders: readonly (string | null)[]): boolean {
  const keys = orders.filter((order): order is string => order !== null);
  return keys.every((order, index) => index === 0 || must(keys[index - 1]) < order);
}

function apply(children: readonly Child[], roomId: string, targetIndex: number): Child[] {
  const changes = new Map(
    reorderChildren(children, roomId, targetIndex).map((change) => [change.roomId, change.order])
  );
  const from = children.findIndex((entry) => entry.roomId === roomId);
  const moved = [...children];
  moved.splice(from, 1);
  moved.splice(targetIndex, 0, must(children[from]));

  return moved.map((entry) => ({
    roomId: entry.roomId,
    order: changes.has(entry.roomId) ? must(changes.get(entry.roomId)) : entry.order,
  }));
}

test('a key between two orders sorts strictly between them', () => {
  const between = must(orderBetween('a', 'c'));

  expect('a' < between).toBe(true);
  expect(between < 'c').toBe(true);
});

test('a key before everything sorts below the first order', () => {
  expect(must(orderBetween(null, 'b')) < 'b').toBe(true);
});

test('a key after everything sorts above the last order', () => {
  expect('y' < must(orderBetween('y', null))).toBe(true);
});

test('adjacent orders are split by lengthening rather than colliding', () => {
  const between = must(orderBetween('a', 'b'));

  expect('a' < between).toBe(true);
  expect(between < 'b').toBe(true);
});

test('generated keys stay inside the printable ASCII range the spec allows', () => {
  let low: string | null = null;

  for (let step = 0; step < 40; step += 1) {
    const next: string = must(orderBetween(low, 'b'));
    for (let index = 0; index < next.length; index += 1) {
      expect(next.charCodeAt(index)).toBeGreaterThanOrEqual(0x20);
      expect(next.charCodeAt(index)).toBeLessThanOrEqual(0x7e);
    }
    expect(next.length).toBeLessThanOrEqual(50);
    low = next;
  }
});

test('an already sorted list keeps every key it had', () => {
  expect(orderKeys(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
});

test('a fully unordered list is left unordered', () => {
  expect(orderKeys([null, null, null])).toEqual([null, null, null]);
});

test('an unordered entry ahead of an ordered one is given a key', () => {
  const keys = orderKeys([null, 'm']);

  expect(must(keys[0]) < 'm').toBe(true);
  expect(keys[1]).toBe('m');
});

test('an out of sequence key is rewritten to keep the list ascending', () => {
  const keys = orderKeys(['b', 'a', 'c']);

  expect(keys[0]).toBe('b');
  expect('b' < must(keys[1])).toBe(true);
  expect(must(keys[1]) < 'c').toBe(true);
  expect(keys[2]).toBe('c');
});

test('every key orderKeys returns is strictly ascending', () => {
  const cases: (string | null)[][] = [
    ['c', 'a', 'b'],
    [null, 'a', null, 'b'],
    ['z', null, null],
    ['a', 'a', 'a'],
  ];

  for (const input of cases) {
    expect(ascending(orderKeys(input))).toBe(true);
  }
});

test('moving a room reports only the entries whose key changed', () => {
  const children = [child('!a', 'a'), child('!b', 'b'), child('!c', 'c')];
  const changes = reorderChildren(children, '!c', 0);

  expect(changes.map((change) => change.roomId)).toEqual(['!c']);
  expect(must(must(changes[0]).order) < 'a').toBe(true);
});

test('the reported keys place the moved room at its new index', () => {
  const children = [child('!a', 'a'), child('!b', 'b'), child('!c', 'c')];
  const result = apply(children, '!a', 2);

  expect(result.map((entry) => entry.roomId)).toEqual(['!b', '!c', '!a']);
  expect(ascending(result.map((entry) => entry.order))).toBe(true);
});

test('moving an unordered room into place assigns keys to what it passes', () => {
  const children = [child('!a', null), child('!b', null), child('!c', null)];
  const result = apply(children, '!c', 0);

  expect(result.map((entry) => entry.roomId)).toEqual(['!c', '!a', '!b']);
  expect(result.every((entry) => entry.order !== null)).toBe(true);
  expect(ascending(result.map((entry) => entry.order))).toBe(true);
});

test('moving a room nowhere changes nothing', () => {
  const children = [child('!a', 'a'), child('!b', 'b')];

  expect(reorderChildren(children, '!a', 0)).toEqual([]);
});

test('an unknown room is not a reorder', () => {
  expect(reorderChildren([child('!a', 'a')], '!missing', 0)).toEqual([]);
});

test('repeatedly moving to the front stays inside the key length limit', () => {
  let children = [child('!a', 'a'), child('!b', 'b'), child('!c', 'c')];

  for (let step = 0; step < 60; step += 1) {
    children = apply(children, must(children[children.length - 1]).roomId, 0);
    for (const entry of children) {
      if (entry.order !== null) expect(entry.order.length).toBeLessThanOrEqual(50);
    }
  }

  expect(ascending(children.map((entry) => entry.order))).toBe(true);
});

test('dropping above a target inserts at the target index', () => {
  expect(dropIndex(0, 2, 'above')).toBe(1);
  expect(dropIndex(3, 1, 'above')).toBe(1);
});

test('dropping below a target inserts after it', () => {
  expect(dropIndex(3, 1, 'below')).toBe(2);
  expect(dropIndex(0, 2, 'below')).toBe(2);
});

test('dropping either side of the dragged row is a no-op', () => {
  expect(dropIndex(1, 1, 'above')).toBe(1);
  expect(dropIndex(1, 1, 'below')).toBe(1);
});

test('a drop resolves to the position the list showed', () => {
  const ids = ['!a', '!b', '!c', '!d'];
  const drop = (from: number, target: number, position: DropEdge): string[] => {
    const moved = [...ids];
    moved.splice(from, 1);
    moved.splice(dropIndex(from, target, position), 0, must(ids[from]));
    return moved;
  };

  expect(drop(0, 2, 'below')).toEqual(['!b', '!c', '!a', '!d']);
  expect(drop(3, 0, 'above')).toEqual(['!d', '!a', '!b', '!c']);
  expect(drop(2, 0, 'below')).toEqual(['!a', '!c', '!b', '!d']);
});

test('keyed edges sort ahead of unkeyed ones', () => {
  const sorted = sortEdges([
    { order: null, origin_server_ts: 1 },
    { order: 'b', origin_server_ts: 9 },
    { order: 'a', origin_server_ts: 8 },
  ]);

  expect(sorted.map((edge) => edge.order)).toEqual(['a', 'b', null]);
});

test('edges with equal keys fall back to their timestamp', () => {
  const sorted = sortEdges([
    { order: 'a', origin_server_ts: 5 },
    { order: 'a', origin_server_ts: 2 },
  ]);

  expect(sorted.map((edge) => edge.origin_server_ts)).toEqual([2, 5]);
});
