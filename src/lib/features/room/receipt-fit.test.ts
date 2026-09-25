import { expect, test } from 'vitest';

import { fitsBesideContent, type Box } from './receipt-fit';

const column: Box = { left: 0, right: 600, top: 0, bottom: 200 };
const badge: Box = { left: 540, right: 600, top: 178, bottom: 200 };

function box(left: number, right: number, top: number, bottom: number): Box {
  return { left, right, top, bottom };
}

test('a reaction row that stops short leaves room for the badge beside it', () => {
  const chips = [box(0, 50, 170, 200), box(54, 104, 170, 200)];
  expect(fitsBesideContent(chips, column, badge, 8, false)).toBe(true);
});

test('content reaching into the corner pushes the badge to a row of its own', () => {
  expect(fitsBesideContent([box(0, 560, 100, 200)], column, badge, 8, false)).toBe(false);
});

test('a wide line above the corner band does not count', () => {
  const rects = [box(0, 590, 0, 22), box(0, 300, 22, 200)];
  expect(fitsBesideContent(rects, column, badge, 8, false)).toBe(true);
});

test('containers stretched across the column are ignored in favour of what they hold', () => {
  const rects = [box(0, 600, 170, 200), box(0, 50, 170, 200)];
  expect(fitsBesideContent(rects, column, badge, 8, false)).toBe(true);
});

test('a badge in the gutter beside the column never collides with it', () => {
  const gutter = box(612, 646, 178, 200);
  expect(fitsBesideContent([box(300, 590, 100, 200)], column, gutter, 8, false)).toBe(true);
});

test('right-to-left rows keep the badge clear of the left edge', () => {
  const start = box(0, 60, 178, 200);
  expect(fitsBesideContent([box(500, 600, 170, 200)], column, start, 8, true)).toBe(true);
  expect(fitsBesideContent([box(40, 600, 170, 200)], column, start, 8, true)).toBe(false);
});
