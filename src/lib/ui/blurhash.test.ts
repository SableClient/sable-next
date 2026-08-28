import { isBlurhashValid } from 'blurhash';
import { afterEach, expect, test, vi } from 'vitest';

import { blurhashDataUrl, encodeBlurhash, paintBlurhash } from './blurhash.js';

class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function fakeContext() {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(128),
      width,
      height,
    })),
    createImageData: vi.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    })),
    putImageData: vi.fn(),
  };
}

function fakeCanvas(context: ReturnType<typeof fakeContext> | null) {
  return {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: () => 'data:image/png;base64,stub',
  };
}

function stubDocument(canvas: ReturnType<typeof fakeCanvas>) {
  vi.stubGlobal('document', { createElement: () => canvas });
}

function fakeBitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: () => {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('encodeBlurhash produces a valid hash from a bitmap', () => {
  vi.stubGlobal('ImageData', FakeImageData);
  const context = fakeContext();
  stubDocument(fakeCanvas(context));

  const hash = encodeBlurhash(fakeBitmap(1280, 720));

  expect(hash).not.toBeNull();
  expect(isBlurhashValid(hash ?? '').result).toBe(true);
});

test('encodeBlurhash downsamples large bitmaps before drawing', () => {
  vi.stubGlobal('ImageData', FakeImageData);
  const context = fakeContext();
  stubDocument(fakeCanvas(context));

  encodeBlurhash(fakeBitmap(4000, 2000));

  const [, , drawnWidth, drawnHeight] = context.drawImage.mock.calls[0] as number[];
  expect(Math.max(drawnWidth, drawnHeight)).toBeLessThanOrEqual(32);
});

test('encodeBlurhash returns null without a canvas context', () => {
  stubDocument(fakeCanvas(null));

  expect(encodeBlurhash(fakeBitmap(100, 100))).toBeNull();
});

test('encodeBlurhash returns null for an empty bitmap', () => {
  stubDocument(fakeCanvas(fakeContext()));

  expect(encodeBlurhash(fakeBitmap(0, 0))).toBeNull();
});

test('encodeBlurhash returns null when there is no document', () => {
  vi.stubGlobal('document', undefined);

  expect(encodeBlurhash(fakeBitmap(100, 100))).toBeNull();
});

test('paintBlurhash decodes onto the canvas and sizes it', () => {
  vi.stubGlobal('ImageData', FakeImageData);
  const context = fakeContext();
  const canvas = fakeCanvas(context);

  const painted = paintBlurhash(
    canvas as unknown as HTMLCanvasElement,
    'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    16,
    12
  );

  expect(painted).toBe(true);
  expect(canvas.width).toBe(16);
  expect(canvas.height).toBe(12);
  const [imageData] = context.putImageData.mock.calls[0] as [FakeImageData];
  expect(imageData.width).toBe(16);
  expect(imageData.height).toBe(12);
  expect(imageData.data).toHaveLength(16 * 12 * 4);
});

test('paintBlurhash returns false without a canvas context', () => {
  const canvas = fakeCanvas(null);

  expect(
    paintBlurhash(canvas as unknown as HTMLCanvasElement, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 16, 12)
  ).toBe(false);
});

test('blurhashDataUrl returns the painted canvas as a data URL', () => {
  vi.stubGlobal('ImageData', FakeImageData);
  const canvas = fakeCanvas(fakeContext());
  stubDocument(canvas);

  expect(blurhashDataUrl('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 16, 12)).toBe(
    'data:image/png;base64,stub'
  );
});

test('blurhashDataUrl returns null when the canvas cannot paint', () => {
  stubDocument(fakeCanvas(null));

  expect(blurhashDataUrl('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 16, 12)).toBeNull();
});

test('blurhashDataUrl returns null when there is no document', () => {
  vi.stubGlobal('document', undefined);

  expect(blurhashDataUrl('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 16, 12)).toBeNull();
});
