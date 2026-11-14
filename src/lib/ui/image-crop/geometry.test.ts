import { describe, expect, test } from 'vitest';

import {
  MAX_ZOOM,
  fitFrame,
  fitView,
  panView,
  resizeFrame,
  rotatedSize,
  sourceRect,
  zoomView,
} from './geometry';

const stage = { width: 400, height: 300 };
const image = { width: 1000, height: 500 };

describe('fitFrame', () => {
  test('centres the largest frame of the aspect inside the inset stage', () => {
    expect(fitFrame(stage, 1, 20)).toEqual({
      x: 70,
      y: 20,
      width: 260,
      height: 260,
    });
    expect(fitFrame(stage, 3, 20)).toEqual({
      x: 20,
      y: 90,
      width: 360,
      height: 120,
    });
  });
});

describe('views', () => {
  const frame = fitFrame(stage, 1, 20);

  test('the fitted view covers the frame and crops the centre', () => {
    const view = fitView(image, frame);
    expect(view.scale).toBeCloseTo(260 / 500);
    expect(sourceRect(view, frame)).toEqual({
      x: 250,
      y: 0,
      width: 500,
      height: 500,
    });
  });

  test('panning stops at the image edges', () => {
    const view = panView(fitView(image, frame), image, frame, 10_000, 10_000);
    expect(sourceRect(view, frame)).toMatchObject({ x: 0, y: 0 });
    const other = panView(view, image, frame, -10_000, -10_000);
    expect(sourceRect(other, frame)).toMatchObject({ x: 500, y: 0 });
  });

  test('zooming keeps the anchor still and stays within the zoom range', () => {
    const view = fitView(image, frame);
    const anchor = { x: 200, y: 150 };
    const zoomed = zoomView(view, image, frame, view.scale * 2, anchor);
    const before = sourceRect(view, {
      ...frame,
      x: anchor.x,
      y: anchor.y,
      width: 0,
      height: 0,
    });
    const after = sourceRect(zoomed, {
      ...frame,
      x: anchor.x,
      y: anchor.y,
      width: 0,
      height: 0,
    });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomView(view, image, frame, 1e6, anchor).scale).toBeCloseTo(view.scale * MAX_ZOOM);
    expect(zoomView(view, image, frame, 0, anchor).scale).toBeCloseTo(view.scale);
  });
});

test('a quarter turn swaps the sides', () => {
  expect(rotatedSize(image, 90)).toEqual({ width: 500, height: 1000 });
  expect(rotatedSize(image, 180)).toEqual(image);
});

test('resizing a corner stays inside the bounds and above the minimum', () => {
  const start = { x: 50, y: 50, width: 100, height: 100 };
  const bounds = { x: 20, y: 20, width: 200, height: 200 };
  expect(resizeFrame(start, 'se', 500, 500, bounds, 40)).toEqual({
    x: 50,
    y: 50,
    width: 170,
    height: 170,
  });
  expect(resizeFrame(start, 'nw', 500, -500, bounds, 40)).toEqual({
    x: 110,
    y: 20,
    width: 40,
    height: 130,
  });
});
