// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick, type ComponentProps } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import MediaImage from './MediaImage.svelte';
import { cachedMediaUrl, loadMediaUrl } from './media-url.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

afterEach(() => {
  core.fetchMedia.mockReset();
  core.forgetMedia.mockClear();
  preferences.autoplayGifs = true;
  preferences.pauseAnimationsWhenInactive = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const user = userEvent.setup({ delay: null });
const retryButton = () => screen.getByRole('button', { name: /Retry/ });

function find(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`${selector} was not rendered`);
  return element;
}

test('does not retry a failed media request in a render loop', async () => {
  core.fetchMedia.mockRejectedValue(new Error('thumbnail failed'));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/image',
      alt: 'Image',
      width: 800,
      height: 600,
    },
  });

  await settle();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
});

test('requests a larger thumbnail without changing its displayed dimensions', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/retina-thumbnail',
      alt: 'Image',
      width: 48,
      height: 48,
      thumbnailWidth: 96,
      thumbnailHeight: 96,
    },
  });

  await settle();

  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/retina-thumbnail', 96, 96);
  expect(document.querySelector('img')).toHaveAttribute('width', '48');
  expect(document.querySelector('img')).toHaveAttribute('height', '48');
});

test('scrolling back through a sticker pack reuses loaded previews', async () => {
  const stickerCount = 100;
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const props = (index: number) => ({
    source: `mxc://example.org/scroll-back-sticker-${String(index)}`,
    alt: `Sticker ${String(index)}`,
    width: 72,
    height: 72,
    thumbnailWidth: 144,
    thumbnailHeight: 144,
  });
  const first = render(MediaImage, { props: props(0) });
  await settle();
  const firstUrl = screen.getByAltText('Sticker 0').getAttribute('src');
  first.unmount();

  for (let index = 1; index < stickerCount; index += 1) {
    const row = render(MediaImage, { props: props(index) });
    await settle();
    row.unmount();
  }
  expect(core.fetchMedia).toHaveBeenCalledTimes(stickerCount);

  render(MediaImage, { props: props(0) });
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(stickerCount);
  expect(screen.getByAltText('Sticker 0')).toHaveAttribute('src', firstUrl);
});

test('a 2540-emote pack restores an evicted preview while other media is pending', async () => {
  const props = (index: number) => ({
    source: `mxc://example.org/large-pack-${String(index)}`,
    alt: `Large pack emote ${String(index)}`,
    width: 72,
    height: 72,
    thumbnailWidth: 144,
    thumbnailHeight: 144,
  });
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  for (let index = 0; index < 2540; index += 1) {
    await loadMediaUrl({ session: null, commands: core }, props(index).source, 144, 144);
  }
  expect(core.fetchMedia).toHaveBeenCalledTimes(2540);
  expect(cachedMediaUrl({ session: null }, props(0).source, 144, 144)).toBeUndefined();

  const finish: (() => void)[] = [];
  core.fetchMedia.mockImplementation((source: string) =>
    source === props(0).source
      ? Promise.resolve(new Uint8Array([1]))
      : new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
          finish.push(() => {
            resolve(new Uint8Array([1]));
          });
        })
  );
  for (let index = 2540; index < 2546; index += 1) render(MediaImage, { props: props(index) });
  await settle();
  expect(finish).toHaveLength(6);

  try {
    render(MediaImage, { props: props(0) });
    await settle();
    expect(screen.getByAltText('Large pack emote 0')).toHaveAttribute(
      'src',
      expect.stringContaining('blob:')
    );
    expect(core.fetchMedia).toHaveBeenCalledTimes(2547);
  } finally {
    for (const resolve of finish) resolve();
    await settle();
  }
});

test('does not re-request media that the homeserver cannot provide', async () => {
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  const props = {
    source: 'mxc://example.org/unavailable-image',
    alt: 'Image',
    width: 800,
    height: 600,
  };
  const first = render(MediaImage, { props });

  await settle();
  first.unmount();

  render(MediaImage, { props });
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
});

test('shows an unavailable state instead of a blank image', async () => {
  core.fetchMedia
    .mockRejectedValueOnce(new Error('media unavailable'))
    .mockResolvedValueOnce(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/unavailable-state',
      alt: 'Holiday photo',
      width: 800,
      height: 600,
      onclick: vi.fn(),
      retryable: true,
    },
  });

  await settle();

  expect(screen.getByText(/Holiday photo: Media unavailable/)).toBeInTheDocument();
  expect(retryButton()).toBeEnabled();
  await user.click(retryButton());
  await settle();

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.media-image-unavailable')).toBeNull();
});

test('backs off repeated manual retries', async () => {
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/retry-backoff',
      alt: 'Holiday photo',
      width: 800,
      height: 600,
      retryable: true,
    },
  });

  await settle();
  await user.click(retryButton());
  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  });

  expect(retryButton()).toBeDisabled();
  expect(retryButton()).toHaveTextContent('Retry in 2 seconds');
});

test('a failed hidden image keeps its caption private and its retry accessible', async () => {
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  render(MediaImage, {
    source: 'mxc://example.org/hidden-unavailable',
    alt: 'Secret ending',
    width: 800,
    height: 600,
    spoilerReason: 'Ending',
    spoilerHidden: true,
    retryable: true,
  });
  await settle();

  expect(screen.getByText('Media unavailable')).toBeInTheDocument();
  expect(screen.queryByText(/Secret ending/)).not.toBeInTheDocument();
  expect(retryButton()).toBeEnabled();
});

test('counts the retry backoff down while it waits', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  const instance = render(MediaImage, {
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
  await user.click(retryButton());
  await vi.advanceTimersByTimeAsync(0);
  await tick();

  expect(retryButton()).toHaveTextContent('Retry in 2 seconds');

  await vi.advanceTimersByTimeAsync(1000);
  await tick();

  expect(retryButton()).toHaveTextContent('Retry in 1 second');

  instance.unmount();
  vi.useRealTimers();
});

test('keeps the unavailable state while an automatic retry is in flight', async () => {
  vi.useFakeTimers();
  core.fetchMedia
    .mockRejectedValueOnce(new Error('media unavailable'))
    .mockImplementation(() => new Promise(() => {}));
  const instance = render(MediaImage, {
    props: {
      source: 'mxc://example.org/retry-flicker',
      alt: 'Holiday photo',
      width: 800,
      height: 600,
      blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    },
  });

  await vi.advanceTimersByTimeAsync(0);
  await tick();
  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();

  await vi.advanceTimersByTimeAsync(2_000);
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();
  expect(document.querySelector('.media-image-blurhash')).toBeNull();
  expect(document.querySelector('.media-image-progress')).toBeNull();

  instance.unmount();
  vi.useRealTimers();
});

test('a manual retry shows its progress instead of the unavailable state', async () => {
  vi.useFakeTimers();
  core.fetchMedia
    .mockRejectedValueOnce(new Error('media unavailable'))
    .mockImplementation(() => new Promise(() => {}));
  const instance = render(MediaImage, {
    props: {
      source: 'mxc://example.org/manual-retry',
      alt: 'Holiday photo',
      width: 800,
      height: 600,
      retryable: true,
    },
  });

  await vi.advanceTimersByTimeAsync(0);
  await tick();
  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();

  await fireEvent.click(retryButton());
  await tick();

  expect(document.querySelector('.media-image-unavailable')).toBeNull();
  expect(document.querySelector('.media-image-progress')).not.toBeNull();

  instance.unmount();
  vi.useRealTimers();
});

test('renders clickable media as a button', async () => {
  const onclick = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/interactive',
      alt: 'Image',
      width: 800,
      height: 600,
      onclick,
    },
  });
  const image = screen.getByRole('button', { name: 'Open Image' });

  await user.click(image);

  expect(image).toHaveClass('media-image');
  expect(onclick).toHaveBeenCalledOnce();
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

  const first = render(MediaImage, { props });
  render(MediaImage, { props });
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  resolve(new Uint8Array(new ArrayBuffer()));
  await settle();
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  first.unmount();
});

test('loads SVG images from the original rather than a thumbnail', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
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
});

test('masks a vector avatar with its own bytes when tinting is on', async () => {
  preferences.tintRoomIcons = true;
  core.fetchMedia.mockResolvedValue(
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
  );
  render(MediaImage, {
    props: { source: 'mxc://example.org/tinted', alt: '', width: 96, height: 96, tint: true },
  });
  await settle();
  await fireEvent.load(find('img'));

  expect(find('.media-image-tint')).toBeTruthy();
  expect(find('img').classList.contains('tinted')).toBe(true);
  preferences.tintRoomIcons = false;
});

test('leaves a raster avatar untinted', async () => {
  preferences.tintRoomIcons = true;
  core.fetchMedia.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  render(MediaImage, {
    props: { source: 'mxc://example.org/raster', alt: '', width: 96, height: 96, tint: true },
  });
  await settle();
  await fireEvent.load(find('img'));

  expect(document.querySelector('.media-image-tint')).toBeNull();
  preferences.tintRoomIcons = false;
});

test('loads GIFs from the original so they animate', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
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
});

test('a GIF its sender flagged as still loads the thumbnail (MSC4230)', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/still',
      alt: 'Still image',
      width: 800,
      height: 600,
      mime: 'image/gif',
      animatedHint: false,
    },
  });

  await tick();
  await Promise.resolve();
  expect(core.fetchMedia).not.toHaveBeenCalledWith('mxc://example.org/still', 0, 0);
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/still', 800, 600);
});

test('a PNG its sender flagged as animated loads the original (MSC4230)', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/apng',
      alt: 'Animated PNG',
      width: 800,
      height: 600,
      mime: 'image/png',
      animatedHint: true,
    },
  });

  await tick();
  await Promise.resolve();
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/apng', 0, 0);
});

test('shows a static GIF preview until its play button is pressed', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:animated');
  render(MediaImage, {
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
  void fireEvent.load(preview);
  await tick();

  expect(container.querySelector('canvas')).not.toBeNull();
  expect(container.querySelector('.play-gif')).not.toBeNull();
  expect(container.querySelector('img:not(.gif-preview-source)')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Play GIF' }));
  // The one image plays: hidden behind the canvas until now, shown from here.
  const playing = document.querySelector<HTMLImageElement>('img');
  expect(playing?.src).toBe('blob:animated');
  expect(playing?.getAttribute('aria-hidden')).toBeNull();
  expect(document.querySelector('.play-gif')).toBeNull();
});

test('an autoplay prop overrides the GIF preference in both directions', async () => {
  preferences.autoplayGifs = true;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:held');
  const instance = render(MediaImage, {
    props: {
      source: 'mxc://example.org/held',
      alt: 'Animated sticker',
      width: 304,
      height: 304,
      mime: 'image/gif',
      autoplay: false,
    },
  });

  const container = document.querySelector<HTMLElement>('.media-image');
  if (!container) throw new Error('media image was not rendered');
  await vi.waitFor(() => {
    expect(container.querySelector('.gif-preview-source')).not.toBeNull();
  });
  instance.unmount();

  preferences.autoplayGifs = false;
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/playing',
      alt: 'Animated sticker',
      width: 304,
      height: 304,
      mime: 'image/gif',
      autoplay: true,
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('.gif-preview-source')).toBeNull();
    expect(document.querySelector('.media-image img')).not.toBeNull();
  });
});

test('stops a playing GIF instead of opening the viewer', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onclick = vi.fn();
  render(MediaImage, {
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
  void fireEvent.load(find('.gif-preview-source'));
  await tick();
  await user.click(screen.getByRole('button', { name: 'Play GIF' }));

  const playing = screen.getByRole('button', { name: 'Stop GIF' });
  await user.click(playing);

  expect(onclick).not.toHaveBeenCalled();
  expect(document.querySelector('.play-gif')).not.toBeNull();
  // The wrapper never changes element, only what pressing it means.
  expect(playing).toHaveAccessibleName('Play GIF');
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

  render(MediaImage, {
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

  render(MediaImage, {
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
  await user.click(screen.getByRole('button', { name: 'Play GIF' }));
  await vi.waitFor(() => {
    expect(decoded.length).toBeGreaterThan(held + 2);
  });
  expect(decoded.slice(held, held + 3)).toEqual([1, 2, 0]);
  expect(document.querySelector('.play-gif')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Stop GIF' }));
  const stopped = decoded.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(decoded.length).toBe(stopped);
  expect(document.querySelector('.play-gif')).not.toBeNull();
});

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

async function mountAndLoad(
  props: ComponentProps<typeof MediaImage>,
  served: { width: number; height: number } | null
): Promise<void> {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:served');
  if (served === null) {
    vi.stubGlobal('createImageBitmap', undefined);
  } else {
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ ...served, close: () => {} }));
  }
  render(MediaImage, { props });
  await settle();
}

test('takes its shape from the served file when the event has no dimensions', async () => {
  await mountAndLoad(
    { source: 'mxc://example.org/no-dimensions', alt: 'Image', width: 800, height: 600 },
    { width: 1000, height: 400 }
  );

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(1000 / 400)}`
  );
});

test('keeps the event dimensions when the served file disagrees', async () => {
  // The served file is a thumbnail and need not share the original's shape, so
  // adopting it would resize the row on load and shift everything below.
  await mountAndLoad(
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
});

test('keeps the requested box when the file cannot be decoded', async () => {
  await mountAndLoad(
    { source: 'mxc://example.org/undecodable', alt: 'Image', width: 800, height: 600 },
    null
  );

  expect(document.querySelector('.media-image')?.getAttribute('style')).toContain(
    `--media-ratio: ${String(800 / 600)}`
  );
});

test.each([
  { intrinsicWidth: 1600, intrinsicHeight: 900, expected: 1600 / 900 },
  { intrinsicWidth: 1600, intrinsicHeight: null, expected: 800 / 600 },
  { intrinsicWidth: null, intrinsicHeight: 900, expected: 800 / 600 },
  { intrinsicWidth: 0, intrinsicHeight: 900, expected: 800 / 600 },
])('reserves a valid aspect ratio for $intrinsicWidth x $intrinsicHeight', async (size) => {
  core.fetchMedia.mockRejectedValue(new Error('not needed'));
  render(MediaImage, {
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

  const first = render(MediaImage, { props });
  await vi.waitFor(() => {
    expect(document.querySelector('img.media-image-content')).not.toBeNull();
  });
  void fireEvent.load(find('img.media-image-content'));
  await tick();
  first.unmount();

  render(MediaImage, { props });
  await tick();
  await tick();

  const placeholder = document.querySelector('.media-image-blurhash');
  expect(placeholder === null || placeholder.classList.contains('loaded')).toBe(true);
});

test('holds a placeholder until the image paints', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  render(MediaImage, {
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
  void fireEvent.load(find('img.media-image-content'));
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).not.toBeNull();
});

test('an undecodable file falls back instead of spinning forever', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const onfailed = vi.fn();
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/corrupt',
      alt: 'photo',
      width: 800,
      height: 600,
      retryable: true,
      onfailed,
    },
  });

  for (const request of ['thumbnail', 'original']) {
    await vi.waitFor(() => {
      expect(document.querySelector('img.media-image-content'), request).not.toBeNull();
    });
    void fireEvent.error(find('img.media-image-content'));
    await tick();
  }

  expect(onfailed).toHaveBeenCalledOnce();
  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();
  expect(document.querySelector('.media-image-progress')).toBeNull();
});

test('an undecodable thumbnail falls back to the original, then stops', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const onfailed = vi.fn();
  const source = 'mxc://example.org/undecodable-thumbnail';
  const instance = render(MediaImage, {
    props: { source, alt: 'photo', width: 800, height: 600, onfailed },
  });
  const image = (): HTMLImageElement | null =>
    document.querySelector<HTMLImageElement>('img.media-image-content');

  await vi.advanceTimersByTimeAsync(0);
  void fireEvent.error(image() ?? find('img.media-image-content'));
  await vi.advanceTimersByTimeAsync(0);

  expect(core.fetchMedia).toHaveBeenLastCalledWith(source, 0, 0);
  expect(onfailed).not.toHaveBeenCalled();

  void fireEvent.error(image() ?? find('img.media-image-content'));
  await vi.advanceTimersByTimeAsync(120_000);

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  expect(onfailed).toHaveBeenCalledOnce();
  expect(image()).toBeNull();
  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();
  instance.unmount();
  vi.useRealTimers();
});

test('an effect re-run after an undecodable original does not bring the retries back', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const props = $state({
    source: 'mxc://example.org/undecodable-rerun',
    alt: 'photo',
    width: 800,
    height: 600,
    mime: 'image/png',
  });
  const instance = render(MediaImage, { props });
  const image = (): HTMLImageElement | null =>
    document.querySelector<HTMLImageElement>('img.media-image-content');

  for (let step = 0; step < 2; step += 1) {
    await vi.advanceTimersByTimeAsync(0);
    void fireEvent.error(image() ?? find('img.media-image-content'));
  }
  props.mime = 'image/jpeg';
  await vi.advanceTimersByTimeAsync(120_000);

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.media-image-unavailable')).not.toBeNull();
  instance.unmount();
  vi.useRealTimers();
});

test('a manual retry of an undecodable image drops the stored copy first', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  const source = 'mxc://example.org/undecodable-retried';
  render(MediaImage, {
    props: { source, alt: 'photo', width: 800, height: 600, retryable: true },
  });
  const breakImage = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(document.querySelector('img.media-image-content')).not.toBeNull();
    });
    void fireEvent.error(find('img.media-image-content'));
    await tick();
  };

  await breakImage();
  await breakImage();
  await user.click(retryButton());

  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledTimes(3);
  });
  expect(core.forgetMedia).toHaveBeenCalledWith(source);
  expect(core.fetchMedia).toHaveBeenLastCalledWith(source, 800, 600);
});

test('a GIF pressed while it downloads keeps its placeholder', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockReturnValue(new Promise(() => undefined));
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/slow-gif',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
    },
  });
  await tick();

  await user.click(find('button.media-image'));
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).toBeNull();
  expect(document.querySelector('.media-image-progress')).not.toBeNull();
});

test('shows a spinner and the byte size until the image paints', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  render(MediaImage, {
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
  void fireEvent.load(find('img.media-image-content'));
  await tick();

  expect(document.querySelector('.media-image-progress')).toBeNull();
  expect(document.querySelector('.media-image-size')).toBeNull();
});

test('loads animation-capable formats from the original', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  render(MediaImage, {
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
});

test('a held GIF with no blurhash is covered while it downloads', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
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
  void fireEvent.load(find('.gif-preview-source'));
  await tick();

  expect(document.querySelector('.media-image-placeholder.loaded')).not.toBeNull();
});

test('a held GIF is covered while it downloads', async () => {
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaImage, {
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
  void fireEvent.load(find('.gif-preview-source'));
  await tick();

  expect(document.querySelector('.media-image-blurhash.loaded')).not.toBeNull();
});

test('falls back to the original when the thumbnail comes back sideways', async () => {
  await mountAndLoad(
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
});

test('keeps the thumbnail when the served shape is merely different', async () => {
  await mountAndLoad(
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

  const viewer = render(MediaImage, { props: { ...props, original: true } });
  await settle();
  viewer.unmount();

  render(MediaImage, {
    props: { ...props, intrinsicWidth: 3024, intrinsicHeight: 4032 },
  });
  await settle();

  expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:original');
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

  const first = render(MediaImage, { props });
  await settle();
  first.unmount();

  render(MediaImage, { props });
  await tick();

  expect(document.querySelector('.media-image-progress')).toBeNull();
  expect(document.querySelector('.media-image-size')).toBeNull();
});

test('retries a failed load on its own, without a retry button', async () => {
  vi.useFakeTimers();
  core.fetchMedia
    .mockRejectedValueOnce(new Error('media unavailable'))
    .mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = render(MediaImage, {
    props: {
      source: 'mxc://remote.example/cold-avatar',
      alt: '',
      width: 96,
      height: 96,
    },
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(core.fetchMedia).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(2000);

  expect(core.fetchMedia).toHaveBeenCalledTimes(2);
  instance.unmount();
  vi.useRealTimers();
});

async function mountLoadedEmote(source: string): Promise<{
  image: () => HTMLImageElement | null;
}> {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(4)));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue(`blob:${source}`);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;still');
  render(MediaImage, {
    props: { source, alt: 'party', width: 32, height: 32, original: true },
  });
  const image = () => document.querySelector<HTMLImageElement>('img.media-image-content');
  await vi.waitFor(() => {
    expect(image()).not.toBeNull();
  });
  const loaded = image();
  if (!loaded) throw new Error('emote was not rendered');
  Object.defineProperty(loaded, 'complete', { value: true });
  Object.defineProperty(loaded, 'naturalWidth', { value: 32 });
  Object.defineProperty(loaded, 'naturalHeight', { value: 32 });
  void fireEvent.load(loaded);
  await tick();
  return { image };
}

test('holds an animated emote on a still frame while the window is inactive', async () => {
  preferences.pauseAnimationsWhenInactive = true;
  let focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const { image } = await mountLoadedEmote('mxc://example.org/inactive-emote');
  const element = image();
  expect(element?.getAttribute('src')).toBe('blob:mxc://example.org/inactive-emote');

  focused = false;
  window.dispatchEvent(new Event('blur'));
  await tick();
  expect(image()).toBe(element);
  expect(element?.getAttribute('src')).toBe('data:image/png;still');

  focused = true;
  window.dispatchEvent(new Event('focus'));
  await tick();
  expect(element?.getAttribute('src')).toBe('blob:mxc://example.org/inactive-emote');
});

test('keeps animating while the window is inactive when the preference is off', async () => {
  let focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const { image } = await mountLoadedEmote('mxc://example.org/unpaused-emote');

  focused = false;
  window.dispatchEvent(new Event('blur'));
  await tick();

  expect(image()?.getAttribute('src')).toBe('blob:mxc://example.org/unpaused-emote');
});

test('a GIF played by hand holds its frame while the window is inactive', async () => {
  preferences.autoplayGifs = false;
  preferences.pauseAnimationsWhenInactive = true;
  let focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:held-by-hand');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
  );
  const decoded: number[] = [];
  vi.stubGlobal(
    'ImageDecoder',
    class {
      tracks = { ready: Promise.resolve(), selectedTrack: { animated: true, frameCount: 3 } };
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
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/held-by-hand',
      alt: 'Animated image',
      width: 800,
      height: 600,
      mime: 'image/gif',
    },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.play-gif')).not.toBeNull();
  });
  await user.click(find('button.media-image'));
  await vi.waitFor(() => {
    expect(decoded.length).toBeGreaterThan(2);
  });

  focused = false;
  window.dispatchEvent(new Event('blur'));
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const held = decoded.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(decoded.length).toBe(held);

  focused = true;
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => {
    expect(decoded.length).toBeGreaterThan(held);
  });
});

test('an encrypted picture loads the sender thumbnail instead of the original', async () => {
  const source = JSON.stringify({ url: 'mxc://example.org/sealed-original' });
  const thumbnail = JSON.stringify({ url: 'mxc://example.org/sealed-thumbnail' });
  render(MediaImage, {
    props: { source, thumbnail, alt: 'Photo', width: 800, height: 600 },
  });

  await settle();

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  expect(core.fetchMedia).toHaveBeenCalledWith(thumbnail, 800, 600);
});

test('resizing an encrypted picture reuses its original file', async () => {
  const source = JSON.stringify({ url: 'mxc://example.org/encrypted-resize' });
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const image = render(MediaImage, {
    props: { source, alt: 'Photo', width: 800, height: 600 },
  });
  await settle();
  const url = document.querySelector('img')?.src;
  expect(url).toBeTruthy();

  await image.rerender({ source, alt: 'Photo', width: 400, height: 300 });
  await settle();
  expect(document.querySelector('img')?.src).toBe(url);
  expect(core.fetchMedia).toHaveBeenCalledOnce();

  await image.rerender({ source, alt: 'Photo', width: 400, height: 300, original: true });
  await settle();
  expect(document.querySelector('img')?.src).toBe(url);
  expect(core.fetchMedia).toHaveBeenCalledOnce();
});

test('a plain picture keeps the server thumbnail of the original', async () => {
  render(MediaImage, {
    props: {
      source: 'mxc://example.org/plain-original',
      thumbnail: 'mxc://example.org/plain-thumbnail',
      alt: 'Photo',
      width: 800,
      height: 600,
    },
  });

  await settle();

  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/plain-original', 800, 600);
});
