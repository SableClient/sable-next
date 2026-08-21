// @vitest-environment happy-dom

import { mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
}));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import MediaImage from './MediaImage.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';

afterEach(() => {
  core.fetchMedia.mockReset();
  preferences.autoplayGifs = true;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

test('does not re-request media that the homeserver cannot provide', async () => {
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  const props = {
    source: 'mxc://example.org/unavailable-image',
    alt: 'Image',
    width: 800,
    height: 600,
  };
  const first = mount(MediaImage, { target: document.body, props });

  await tick();
  await Promise.resolve();
  await tick();
  await unmount(first);

  const second = mount(MediaImage, { target: document.body, props });
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  await unmount(second);
});

test('shows an unavailable state instead of a blank image', async () => {
  core.fetchMedia
    .mockRejectedValueOnce(new Error('media unavailable'))
    .mockResolvedValueOnce(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/unavailable-state',
      alt: 'Holiday photo',
      width: 800,
      height: 600,
      onclick: vi.fn(),
      retryable: true,
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('.media-image-unavailable')?.textContent).toContain(
    'Holiday photo: Media unavailable'
  );
  const retry = document.querySelector<HTMLButtonElement>('.retry-media');
  expect(retry?.disabled).toBe(false);
  retry?.click();
  await Promise.resolve();
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.media-image-unavailable')).toBeNull();
  await unmount(instance);
});

test('backs off repeated manual retries', async () => {
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/retry-backoff',
      alt: 'Holiday photo',
      width: 800,
      height: 600,
      retryable: true,
    },
  });

  await tick();
  await Promise.resolve();
  await tick();
  document.querySelector<HTMLButtonElement>('.retry-media')?.click();
  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  });

  const retry = document.querySelector<HTMLButtonElement>('.retry-media');
  expect(retry?.disabled).toBe(true);
  expect(retry?.textContent).toContain('Retry in 2 seconds');
  await unmount(instance);
});

test('renders clickable media as a button', async () => {
  const onclick = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/interactive',
      alt: 'Image',
      width: 800,
      height: 600,
      onclick,
    },
  });
  const image = document.querySelector<HTMLElement>('.media-image');
  if (!image) throw new Error('interactive media image was not rendered');

  image.click();
  await tick();

  expect(image.tagName).toBe('BUTTON');
  expect(onclick).toHaveBeenCalledOnce();
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

test('loads GIFs from the original so they animate', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/autoplayed',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
    },
  });

  await tick();
  await Promise.resolve();
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/autoplayed', 0, 0);
  await unmount(instance);
});

test('shows a static GIF preview until its play button is pressed', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:animated');
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/animated',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
    },
  });

  const container = document.querySelector<HTMLElement>('.media-image');
  if (!container) throw new Error('media image was not rendered');
  await vi.waitFor(() => {
    expect(container.querySelector('.gif-preview-source')).not.toBeNull();
  });
  const preview = container.querySelector<HTMLImageElement>('.gif-preview-source');
  if (!preview) throw new Error('GIF preview source was not rendered');
  preview.dispatchEvent(new Event('load'));
  await tick();

  expect(container.querySelector('canvas')).not.toBeNull();
  expect(container.querySelector('.play-gif')).not.toBeNull();
  expect(container.querySelector('img:not(.gif-preview-source)')).toBeNull();

  document.querySelector<HTMLButtonElement>('.play-gif')?.click();
  await tick();
  // The one image plays: hidden behind the canvas until now, shown from here.
  const playing = document.querySelector<HTMLImageElement>('img');
  expect(playing?.src).toBe('blob:animated');
  expect(playing?.getAttribute('aria-hidden')).toBeNull();
  expect(document.querySelector('.play-gif')).toBeNull();
  await unmount(instance);
});

test('stops a playing GIF instead of opening the viewer', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onclick = vi.fn();
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/stoppable',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
      onclick,
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('.gif-preview-source')).not.toBeNull();
  });
  document.querySelector('.gif-preview-source')?.dispatchEvent(new Event('load'));
  await tick();
  document.querySelector<HTMLButtonElement>('.play-gif')?.click();
  await tick();

  const playing = document.querySelector<HTMLButtonElement>('button.media-image');
  if (!playing) throw new Error('playing GIF was not interactive');
  playing.click();
  await tick();

  expect(onclick).not.toHaveBeenCalled();
  expect(document.querySelector('.play-gif')).not.toBeNull();
  // The wrapper never changes element, only what pressing it means.
  expect(document.querySelector('button.media-image')?.getAttribute('aria-label')).toBe('Play GIF');
  await unmount(instance);
});

test('steps GIF frames itself and stops on the frame it held', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stepped');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
  );
  const decoded: number[] = [];
  vi.stubGlobal(
    'ImageDecoder',
    class {
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { animated: true, frameCount: 3 },
      };
      completed = Promise.resolve();
      decode({ frameIndex }: { frameIndex: number }) {
        decoded.push(frameIndex);
        return Promise.resolve({
          image: { displayWidth: 4, displayHeight: 4, duration: 20_000, close: () => {} },
        });
      }
      close() {}
    }
  );

  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/stepped',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
    },
  });

  // A frame is decoded and held, with no <img> left to animate on its own.
  await vi.waitFor(() => {
    expect(document.querySelector('.play-gif')).not.toBeNull();
  });
  expect(document.querySelector('img')).toBeNull();
  expect(decoded.at(-1)).toBe(0);

  const held = decoded.length;
  document.querySelector<HTMLButtonElement>('button.media-image')?.click();
  await vi.waitFor(() => {
    expect(decoded.length).toBeGreaterThan(held + 2);
  });
  expect(decoded.slice(held, held + 3)).toEqual([1, 2, 0]);
  expect(document.querySelector('.play-gif')).toBeNull();

  document.querySelector<HTMLButtonElement>('button.media-image')?.click();
  await tick();
  const stopped = decoded.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(decoded.length).toBe(stopped);
  expect(document.querySelector('.play-gif')).not.toBeNull();
  await unmount(instance);
});

async function mountAndLoad(
  props: ComponentProps<typeof MediaImage>,
  served: { width: number; height: number } | null
): Promise<() => Promise<void>> {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:served');
  if (served === null) {
    vi.stubGlobal('createImageBitmap', undefined);
  } else {
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ ...served, close: () => {} }));
  }
  const instance = mount(MediaImage, { target: document.body, props });
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await tick();

  return () => unmount(instance);
}

test('takes its shape from the served file when the event has no dimensions', async () => {
  const dispose = await mountAndLoad(
    { source: 'mxc://example.org/no-dimensions', alt: 'Image', width: 800, height: 600 },
    { width: 1000, height: 400 }
  );

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(1000 / 400)}`
  );
  await dispose();
});

test('keeps the event dimensions when the served file disagrees', async () => {
  // The served file is a thumbnail and need not share the original's shape, so
  // adopting it would resize the row on load and shift everything below.
  const dispose = await mountAndLoad(
    {
      source: 'mxc://example.org/thumbnailed',
      alt: 'Image',
      width: 800,
      height: 600,
      intrinsicWidth: 600,
      intrinsicHeight: 900,
    },
    { width: 1000, height: 400 }
  );

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(600 / 900)}`
  );
  await dispose();
});

test('keeps the requested box when the file cannot be decoded', async () => {
  const dispose = await mountAndLoad(
    { source: 'mxc://example.org/undecodable', alt: 'Image', width: 800, height: 600 },
    null
  );

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(800 / 600)}`
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
