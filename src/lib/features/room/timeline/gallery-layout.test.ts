import { expect, test } from 'vitest';

import { partitionGallery } from './gallery-layout.js';

const images = (count: number) => Array.from({ length: count }, () => ({ kind: 'image' }));
const shape = (count: number) =>
  partitionGallery(images(count)).groups.map((group) => [group.layout, group.entries.length]);

test.each([
  [1, [['one', 1]]],
  [2, [['two', 2]]],
  [3, [['featured', 3]]],
  [4, [['two', 4]]],
  [
    5,
    [
      ['one', 1],
      ['two', 4],
    ],
  ],
  [6, [['three', 6]]],
  [
    7,
    [
      ['one', 1],
      ['three', 6],
    ],
  ],
  [
    8,
    [
      ['two', 2],
      ['three', 6],
    ],
  ],
  [9, [['three', 9]]],
  [
    12,
    [
      ['featured', 3],
      ['three', 9],
    ],
  ],
])('lays out %i images as legacy did', (count, expected) => {
  expect(shape(count)).toEqual(expected);
});

test('keeps each item at its sent position when files sit between images', () => {
  const { groups, attachments } = partitionGallery([
    { kind: 'image' },
    { kind: 'file' },
    { kind: 'video' },
    { kind: 'audio' },
  ]);

  expect(groups).toEqual([
    {
      layout: 'two',
      entries: [
        { item: { kind: 'image' }, index: 0 },
        { item: { kind: 'video' }, index: 2 },
      ],
    },
  ]);
  expect(attachments.map((entry) => entry.index)).toEqual([1, 3]);
});

test('has nothing to lay out for an empty gallery', () => {
  expect(partitionGallery([])).toEqual({ groups: [], attachments: [] });
});
