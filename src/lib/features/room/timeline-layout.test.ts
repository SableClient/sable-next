import { expect, test } from 'vitest';

import {
  estimatedColumnPx,
  estimateRowSize,
  mediaColumnPx,
  TIMELINE_LAYOUT,
  TIMELINE_LAYOUT_STYLE,
} from './timeline-layout';

const MEDIA_MAX_PX = TIMELINE_LAYOUT.mediaMaxRem * 16;
const MEDIA_MIN_PX = TIMELINE_LAYOUT.mediaMinRem * 16;
const CHROME_PX = TIMELINE_LAYOUT.mediaRowChromePx;

function image(width: number | null, height: number | null) {
  return {
    kind: 'image',
    filename: 'Picture',
    caption: null,
    html: null,
    source: 'mxc://example.org/picture',
    mime: 'image/png',
    width,
    height,
    size: null,
    blurhash: null,
    thumbnail: null,
    spoiler: null,
  } as const;
}

test('publishes media dimensions as inherited CSS properties', () => {
  expect(TIMELINE_LAYOUT_STYLE).toBe(
    '--timeline-media-max:25rem;--timeline-media-min:8rem;--timeline-sticker-width:9.5rem'
  );
});

test('the media column is the measured column, bounded by the floor and the cap', () => {
  expect(mediaColumnPx(320)).toBe(320);
  expect(mediaColumnPx(646)).toBe(MEDIA_MAX_PX);
  expect(mediaColumnPx(0)).toBe(MEDIA_MIN_PX);
});

test('the first frame has no row to measure, so it falls back to the viewport', () => {
  expect(estimatedColumnPx(390)).toBeCloseTo(390 - TIMELINE_LAYOUT.mediaInsetRem * 16, 5);
});

test('a picture row is reserved from the column it will actually get', () => {
  const phone = estimateRowSize(image(1600, 900), mediaColumnPx(320));
  const desktop = estimateRowSize(image(1600, 900), mediaColumnPx(646));

  expect(phone).toBeCloseTo(320 / (1600 / 900) + CHROME_PX, 0);
  expect(desktop).toBeCloseTo(MEDIA_MAX_PX / (1600 / 900) + CHROME_PX, 5);
  expect(phone).toBeLessThan(desktop ?? 0);
});

test('a portrait is reserved from the width its ratio leaves, not from the full column', () => {
  const portrait = estimateRowSize(image(600, 900), mediaColumnPx(646));
  const landscape = estimateRowSize(image(1600, 900), mediaColumnPx(646));

  expect(portrait).toBeGreaterThan(landscape ?? 0);
  expect(portrait).toBeCloseTo(MEDIA_MAX_PX + CHROME_PX, 5);
});

test('a picture taller than the floor allows reserves the capped box, not the uncapped one', () => {
  expect(estimateRowSize(image(200, 6000), mediaColumnPx(646))).toBeCloseTo(
    MEDIA_MAX_PX + CHROME_PX,
    5
  );
});

test('a sticker keeps its fixed width, which no column and no cap bound', () => {
  expect(
    estimateRowSize(
      {
        kind: 'sticker',
        body: 'Sticker',
        source: 'mxc://example.org/sticker',
        mime: 'image/png',
        width: 512,
        height: 512,
      },
      mediaColumnPx(320)
    )
  ).toBeCloseTo(TIMELINE_LAYOUT.stickerWidthRem * 16 + CHROME_PX, 5);
});

test('falls back to the measured mean for a row whose height it cannot predict', () => {
  expect(
    estimateRowSize(
      { kind: 'message', body: 'Hello', html: 'Hello', emote: false, notice: false, edited: false },
      mediaColumnPx(320)
    )
  ).toBeUndefined();
});
