import { expect, test } from 'vitest';

import { fitsBesideContent, type Box } from './receipt-fit';

const frame: Box = { left: 0, right: 600, top: 0, bottom: 200 };
const corner = { width: 60, height: 22, gap: 8, rtl: false };

function box(left: number, right: number, top: number, bottom: number): Box {
  return { left, right, top, bottom };
}

test('a reaction row that stops short leaves room for the badge beside it', () => {
  const chips = [box(0, 50, 170, 200), box(54, 104, 170, 200)];
  expect(fitsBesideContent(chips, frame, 200, corner)).toBe(true);
});

test('content reaching into the corner pushes the badge to a row of its own', () => {
  expect(fitsBesideContent([box(0, 560, 100, 200)], frame, 200, corner)).toBe(false);
});

test('a wide line above the corner band does not count', () => {
  const rects = [box(0, 590, 0, 22), box(0, 300, 22, 200)];
  expect(fitsBesideContent(rects, frame, 200, corner)).toBe(true);
});

test('containers stretched across the column are ignored in favour of what they hold', () => {
  const rects = [box(0, 600, 170, 200), box(0, 50, 170, 200)];
  expect(fitsBesideContent(rects, frame, 200, corner)).toBe(true);
});

test('right-to-left rows keep the badge clear of the left edge', () => {
  const rtl = { ...corner, rtl: true };
  expect(fitsBesideContent([box(500, 600, 170, 200)], frame, 200, rtl)).toBe(true);
  expect(fitsBesideContent([box(40, 600, 170, 200)], frame, 200, rtl)).toBe(false);
});
