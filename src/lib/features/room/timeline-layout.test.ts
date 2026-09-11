import { expect, test } from 'vitest';

import { estimateRowSize, TIMELINE_LAYOUT, TIMELINE_LAYOUT_STYLE } from './timeline-layout';

test('publishes media dimensions as inherited CSS properties', () => {
  expect(TIMELINE_LAYOUT_STYLE).toBe('--timeline-media-max:25rem;--timeline-sticker-width:9.5rem');
});

test('reserves a picture row from the event dimensions rather than the measured mean', () => {
  const portrait = estimateRowSize({
    kind: 'image',
    body: 'Portrait',
    html: null,
    source: 'mxc://example.org/portrait',
    filename: null,
    mime: 'image/png',
    width: 600,
    height: 900,
    size: null,
    blurhash: null,
    spoiler: null,
  });
  const landscape = estimateRowSize({
    kind: 'image',
    body: 'Landscape',
    html: null,
    source: 'mxc://example.org/landscape',
    filename: null,
    mime: 'image/png',
    width: 1600,
    height: 900,
    size: null,
    blurhash: null,
    spoiler: null,
  });

  expect(portrait).toBeGreaterThan(landscape ?? 0);
  expect(portrait).toBeCloseTo(
    (TIMELINE_LAYOUT.mediaMaxRem * 16) / (600 / 900) + TIMELINE_LAYOUT.mediaRowChromePx,
    5
  );
});

test('falls back to the measured mean for a row whose height it cannot predict', () => {
  expect(
    estimateRowSize({
      kind: 'message',
      body: 'Hello',
      html: 'Hello',
      emote: false,
      notice: false,
      edited: false,
    })
  ).toBeUndefined();
});
