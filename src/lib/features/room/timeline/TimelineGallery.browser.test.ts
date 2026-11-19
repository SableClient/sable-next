import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { GalleryItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import TimelineGallery from './TimelineGallery.svelte';

const image = (name: string, width: number, height: number): GalleryItemView => ({
  kind: 'image',
  filename: name,
  caption: null,
  source: `mxc://example.test/${name}`,
  mime: 'image/png',
  width,
  height,
  size: null,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
});

function tiles(): DOMRect[] {
  return [...document.querySelectorAll('.gallery .tile')].map((tile) =>
    tile.getBoundingClientRect()
  );
}

test('shows three images as one tall tile beside two stacked squares', async () => {
  await page.viewport(414, 800);
  await render(TimelineGallery, {
    items: [image('tall', 400, 900), image('wide', 1600, 900), image('small', 64, 64)],
    body: '',
    html: '',
  });

  await expect.poll(() => tiles().length).toBe(3);
  const [first, second, third] = tiles() as [DOMRect, DOMRect, DOMRect];
  expect(second.width).toBeCloseTo(second.height, 0);
  expect(third.width).toBeCloseTo(third.height, 0);
  expect(third.left).toBeCloseTo(second.left, 0);
  expect(third.top).toBeGreaterThan(second.bottom);
  expect(first.top).toBeCloseTo(second.top, 0);
  expect(first.bottom).toBeCloseTo(third.bottom, 0);
  expect(first.width).toBeCloseTo(second.width, 0);
});

test('leads five images with the odd one and squares the other four', async () => {
  await page.viewport(360, 800);
  await render(TimelineGallery, {
    items: [
      image('lead', 1600, 900),
      image('a', 400, 900),
      image('b', 900, 400),
      image('c', 64, 64),
      image('d', 800, 600),
    ],
    body: '',
    html: '',
  });

  await expect.poll(() => tiles().length).toBe(5);
  const [lead, ...grid] = tiles() as [DOMRect, ...DOMRect[]];
  expect(lead.width / lead.height).toBeCloseTo(1600 / 900, 1);
  for (const tile of grid) expect(tile.width).toBeCloseTo(tile.height, 0);
  expect(grid[0]?.top).toBeGreaterThan(lead.bottom);
  expect(grid[1]?.top).toBeCloseTo(grid[0]?.top ?? 0, 0);
  expect(grid[2]?.top).toBeGreaterThan(grid[0]?.bottom ?? 0);
});
