import { expect, test } from 'vitest';

import type { DropEdge } from '#lib/ui/drag-list.js';

import { dropIndex } from './space-order';

function must<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

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
