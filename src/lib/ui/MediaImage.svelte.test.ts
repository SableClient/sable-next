// @vitest-environment happy-dom

import { mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => {
  const fetchMedia = vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>();

  return { fetchMedia, commands: { fetchMedia } };
});

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

test('counts the retry backoff down while it waits', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/retry-countdown',
      alt: 'Holiday photo',
      width: 800,
      height: 600,
      retryable: true,
    },
  });

  await vi.advanceTimersByTimeAsync(0);
  await tick();
  document.querySelector<HTMLButtonElement>('.retry-media')?.click();
  await vi.advanceTimersByTimeAsync(0);
  await tick();

  expect(document.querySelector('.retry-media')?.textContent).toContain('Retry in 2 seconds');

  await vi.advanceTimersByTimeAsync(1000);
  await tick();

  expect(document.querySelector('.retry-media')?.textContent).toContain('Retry in 1 second');

  await unmount(instance);
  vi.useRealTimers();
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

test('keeps the GIF on screen until the decoder has painted a frame', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
  );
  vi.stubGlobal(
    'ImageDecoder',
    class {
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { animated: true, frameCount: 3 },
      };
      completed = Promise.resolve();
      decode() {
        return new Promise(() => undefined);
      }
      close() {}
    }
  );

  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/pending-frames',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('.gif-preview-source')).not.toBeNull();
  });
  await tick();
  await tick();

  expect(document.querySelector<HTMLImageElement>('.gif-preview-source')?.src).toBe('blob:pending');
  expect(document.querySelector('.gif-preview-source.ready')).toBeNull();
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

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

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
  await settle();

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

test('a cached image does not come back blurred', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const props = {
    source: 'mxc://example.org/cached-photo',
    alt: 'photo',
    width: 320,
    height: 240,
    blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  };

  const first = mount(MediaImage, { target: document.body, props });
  await vi.waitFor(() => {
    expect(document.querySelector('img.media-image-content')).not.toBeNull();
  });
  document
    .querySelector<HTMLImageElement>('img.media-image-content')
    ?.dispatchEvent(new Event('load'));
  await tick();
  await unmount(first);

  const second = mount(MediaImage, { target: document.body, props });
  await tick();
  await tick();

  const placeholder = document.querySelector('.media-image-blurhash');
  expect(placeholder === null || placeholder.classList.contains('loaded')).toBe(true);
  await unmount(second);
});

test('holds a placeholder until the image paints', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/slow-photo',
      alt: 'photo',
      width: 320,
      height: 240,
    },
  });
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).toBeNull();
  expect(document.querySelector('.media-image-placeholder')).not.toBeNull();

  await vi.waitFor(() => {
    expect(document.querySelector('img.media-image-content')).not.toBeNull();
  });
  document
    .querySelector<HTMLImageElement>('img.media-image-content')
    ?.dispatchEvent(new Event('load'));
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).not.toBeNull();
  await unmount(instance);
});

test('an undecodable file falls back instead of spinning forever', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const onfailed = vi.fn();
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/corrupt',
      alt: 'photo',
      width: 800,
      height: 600,
      retryable: true,
      onfailed,
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('img.media-image-content')).not.toBeNull();
  });
  document
    .querySelector<HTMLImageElement>('img.media-image-content')
    ?.dispatchEvent(new Event('error'));
  await tick();

  expect(onfailed).toHaveBeenCalledOnce();
  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();
  expect(document.querySelector('.media-image-progress')).toBeNull();
  await unmount(instance);
});

test('a GIF pressed while it downloads keeps its placeholder', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockReturnValue(new Promise(() => undefined));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/slow-gif',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
    },
  });
  await tick();

  document.querySelector<HTMLButtonElement>('button.media-image')?.click();
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).toBeNull();
  expect(document.querySelector('.media-image-progress')).not.toBeNull();
  await unmount(instance);
});

test('shows a spinner and the byte size until the image paints', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/heavy',
      alt: 'photo',
      width: 800,
      height: 600,
      size: 2_761_335,
    },
  });
  await tick();

  expect(document.querySelector('.media-image-progress')).not.toBeNull();
  expect(document.querySelector('.media-image-size')?.textContent).toBe('2.8 MB');

  await vi.waitFor(() => {
    expect(document.querySelector('img.media-image-content')).not.toBeNull();
  });
  document
    .querySelector<HTMLImageElement>('img.media-image-content')
    ?.dispatchEvent(new Event('load'));
  await tick();

  expect(document.querySelector('.media-image-progress')).toBeNull();
  expect(document.querySelector('.media-image-size')).toBeNull();
  await unmount(instance);
});

test('loads animation-capable formats from the original', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/animated-webp',
      alt: 'dancing.webp',
      width: 800,
      height: 600,
      mime: 'image/webp',
    },
  });

  await tick();
  await Promise.resolve();
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/animated-webp', 0, 0);
  await unmount(instance);
});

test('a held GIF with no blurhash is covered while it downloads', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://gifs.example.org/picked',
      alt: 'a group of people dancing.gif',
      width: 800,
      height: 600,
      intrinsicWidth: 220,
      intrinsicHeight: 280,
      mime: 'image/gif',
    },
  });
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).toBeNull();
  expect(document.querySelector('.media-image-placeholder')).not.toBeNull();

  await vi.waitFor(() => {
    expect(document.querySelector('.gif-preview-source')).not.toBeNull();
  });
  document.querySelector('.gif-preview-source')?.dispatchEvent(new Event('load'));
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).not.toBeNull();
  await unmount(instance);
});

test('a held GIF is covered while it downloads', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaImage, {
    target: document.body,
    props: {
      source: 'mxc://example.org/covered',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
      blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    },
  });
  await tick();

  expect(document.querySelector('.media-image-blurhash.loaded')).toBeNull();
  expect(document.querySelector('.media-image-blurhash')).not.toBeNull();

  await vi.waitFor(() => {
    expect(document.querySelector('.gif-preview-source')).not.toBeNull();
  });
  document.querySelector('.gif-preview-source')?.dispatchEvent(new Event('load'));
  await tick();

  expect(document.querySelector('.media-image-blurhash.loaded')).not.toBeNull();
  await unmount(instance);
});

test('falls back to the original when the thumbnail comes back sideways', async () => {
  const dispose = await mountAndLoad(
    {
      source: 'mxc://example.org/sideways',
      alt: 'Image',
      width: 800,
      height: 600,
      intrinsicWidth: 3024,
      intrinsicHeight: 4032,
    },
    { width: 4032, height: 3024 }
  );

  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/sideways', 800, 600);
  expect(core.fetchMedia).toHaveBeenLastCalledWith('mxc://example.org/sideways', 0, 0);
  await dispose();
});

test('keeps the thumbnail when the served shape is merely different', async () => {
  const dispose = await mountAndLoad(
    {
      source: 'mxc://example.org/cropped',
      alt: 'Image',
      width: 800,
      height: 600,
      intrinsicWidth: 600,
      intrinsicHeight: 900,
    },
    { width: 1000, height: 400 }
  );

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  await dispose();
});

test('measures the thumbnail even once the original has been measured', async () => {
  const source = 'mxc://example.org/viewed-first';
  const props = { source, alt: 'Image', width: 800, height: 600 };
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const bitmaps = [
    { width: 3024, height: 4032 },
    { width: 4032, height: 3024 },
  ];
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ ...(bitmaps.shift() ?? { width: 1, height: 1 }), close: () => {} })
  );
  const objectUrls = ['blob:original', 'blob:thumbnail'];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => objectUrls.shift() ?? 'blob:extra');

  const viewer = mount(MediaImage, { target: document.body, props: { ...props, original: true } });
  await settle();
  await unmount(viewer);

  const timeline = mount(MediaImage, {
    target: document.body,
    props: { ...props, intrinsicWidth: 3024, intrinsicHeight: 4032 },
  });
  await settle();

  expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:original');
  await unmount(timeline);
});

test('does not flash the loading overlay over a GIF it has already fetched', async () => {
  preferences.autoplayGifs = false;
  const props = {
    source: 'mxc://example.org/held-gif',
    alt: 'party.gif',
    width: 800,
    height: 600,
    mime: 'image/gif',
    size: 2_761_335,
  };
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:held-gif');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
  );
  vi.stubGlobal(
    'ImageDecoder',
    class {
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { animated: true, frameCount: 3 },
      };
      completed = Promise.resolve();
      decode() {
        return Promise.resolve({
          image: { displayWidth: 4, displayHeight: 4, duration: 20_000, close: () => {} },
        });
      }
      close() {}
    }
  );

  const first = mount(MediaImage, { target: document.body, props });
  await settle();
  await unmount(first);

  const second = mount(MediaImage, { target: document.body, props });
  await tick();

  expect(document.querySelector('.media-image-progress')).toBeNull();
  expect(document.querySelector('.media-image-size')).toBeNull();
  await unmount(second);
});
