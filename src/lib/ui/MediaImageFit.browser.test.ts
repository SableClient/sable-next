import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import { core } from '#lib/core/__mocks__/context.js';
import { CoreError } from '#src/transport';

import MediaImage from './MediaImage.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
  document.documentElement.style.removeProperty('--font-scale');
});

function overflow(box: Element, selector: string): number {
  const frame = box.getBoundingClientRect();
  return Math.max(
    0,
    ...[...box.querySelectorAll(selector)].map((part) => {
      const rect = part.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return 0;
      return Math.max(
        frame.top - rect.top,
        rect.bottom - frame.bottom,
        frame.left - rect.left,
        rect.right - frame.right
      );
    })
  );
}

async function mountBox(width: number, height: number, failing: boolean, zoom: number) {
  document.documentElement.style.setProperty('--font-scale', String(zoom));
  core.fetchMedia.mockImplementation(() =>
    failing
      ? Promise.reject(new CoreError({ code: 'media_server_unavailable', retry_after_ms: 60_000 }))
      : new Promise(() => {})
  );
  const screen = await render(MediaImage, {
    source: `mxc://example.org/fit-${String(width)}-${String(height)}-${String(failing)}`,
    alt: 'A long descriptive file name for the picture.png',
    width: 800,
    height: 600,
    intrinsicWidth: width * 4,
    intrinsicHeight: height * 4,
    style: `display:block;width:${String(width)}px`,
    retryable: true,
    spoilerHidden: true,
    spoilerReason: failing ? null : '',
  });
  const box = screen.container.querySelector('.media-image');
  if (!box) throw new Error('missing media image');
  return box;
}

const SIZES = [
  [340, 20],
  [340, 42],
  [340, 100],
  [44, 200],
] as const;

for (const zoom of [1, 1.5]) {
  for (const [width, height] of SIZES) {
    const size = `${String(width)}x${String(height)} at zoom ${String(zoom)}`;

    test(`a spoiler cover fits a ${size} image`, async () => {
      const box = await mountBox(width, height, false, zoom);
      await expect.poll(() => box.querySelector('.media-image-spoiler-chip')).not.toBeNull();
      expect(overflow(box, '.media-image-spoiler-chip, .media-image-spoiler-chip *')).toBe(0);
      expect(
        box.querySelector('.media-image-spoiler-chip svg')?.getBoundingClientRect().height
      ).toBeGreaterThan(4);
    });

    test(`a failed image keeps its retry inside a ${size} box`, async () => {
      const box = await mountBox(width, height, true, zoom);
      await expect.poll(() => box.querySelector('.retry-media')).not.toBeNull();
      expect(box.getBoundingClientRect().height).toBeCloseTo(height, 0);
      const cover = box.querySelector('.media-image-unavailable');
      if (!cover) throw new Error('missing unavailable cover');
      expect(overflow(cover, '.retry-media')).toBe(0);
      expect(overflow(box, '.media-image-unavailable')).toBe(0);
    });
  }
}
