// @vitest-environment happy-dom

import { mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
}));

vi.mock('$lib/core/context', () => ({
  useCoreClient: () => core,
}));

import MediaImage from './MediaImage.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('does not retry a failed media request in a render loop', async () => {
  core.fetchMedia.mockRejectedValue(new Error('thumbnail failed'));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/image',
      alt: 'Image',
      width: 800,
      height: 600,
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('shares a pending media request across component instances', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL');
  let resolve!: (bytes: Uint8Array<ArrayBuffer>) => void;
  core.fetchMedia.mockReturnValue(
    new Promise((next) => {
      resolve = next;
    })
  );
  const props = {
    source: 'mxc://example.org/shared-image',
    alt: 'Image',
    width: 800,
    height: 600,
  };

  const first = mount(MediaImage, { target: document.body, props });
  const second = mount(MediaImage, { target: document.body, props });
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  resolve(new Uint8Array(new ArrayBuffer()));
  await Promise.resolve();
  await tick();
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  await unmount(first);
  await unmount(second);
});

test('loads SVG images from the original rather than a thumbnail', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/vector',
      alt: 'Vector image',
      width: 800,
      height: 600,
      mime: 'image/svg+xml',
    },
  });

  await tick();
  await Promise.resolve();
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/vector', 0, 0);
  await unmount(instance);
});

async function mountAndLoad(
  props: ComponentProps<typeof MediaImage>
): Promise<() => Promise<void>> {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:served');
  const instance = mount(MediaImage, { target: document.body, props });
  await tick();
  await Promise.resolve();
  await tick();

  const image = document.querySelector('img');
  if (!image) throw new Error('image never rendered');
  Object.defineProperty(image, 'naturalWidth', { value: 1000 });
  Object.defineProperty(image, 'naturalHeight', { value: 400 });
  image.dispatchEvent(new Event('load'));
  await tick();

  return () => unmount(instance);
}

test('takes its shape from the served file when the event has no dimensions', async () => {
  const dispose = await mountAndLoad({
    source: 'mxc://example.org/no-dimensions',
    alt: 'Image',
    width: 800,
    height: 600,
  });

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(1000 / 400)}`
  );
  await dispose();
});

test('keeps the event dimensions when it has them, so the timeline does not shift', async () => {
  const dispose = await mountAndLoad({
    source: 'mxc://example.org/portrait-event',
    alt: 'Image',
    width: 800,
    height: 600,
    intrinsicWidth: 600,
    intrinsicHeight: 900,
  });

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(600 / 900)}`
  );
  await dispose();
});

test.each([
  { intrinsicWidth: 1600, intrinsicHeight: 900, expected: 1600 / 900 },
  { intrinsicWidth: 1600, intrinsicHeight: null, expected: 800 / 600 },
  { intrinsicWidth: null, intrinsicHeight: 900, expected: 800 / 600 },
  { intrinsicWidth: 0, intrinsicHeight: 900, expected: 800 / 600 },
])('reserves a valid aspect ratio for $intrinsicWidth x $intrinsicHeight', async (size) => {
  core.fetchMedia.mockRejectedValue(new Error('not needed'));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: `mxc://example.org/ratio-${String(size.intrinsicWidth)}-${String(size.intrinsicHeight)}`,
      alt: 'Image',
      width: 800,
      height: 600,
      intrinsicWidth: size.intrinsicWidth,
      intrinsicHeight: size.intrinsicHeight,
    },
  });
  await tick();

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(size.expected)}`
  );
  await unmount(instance);
});
