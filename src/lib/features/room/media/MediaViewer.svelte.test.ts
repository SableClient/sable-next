// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { MediaItem } from './MediaViewer.svelte';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/platform/system-bars.js', () => ({ setSystemBarsHidden: vi.fn() }));

import MediaViewer from './MediaViewer.svelte';
import { resetVideoStreaming } from '#lib/ui/video-stream.svelte.js';
import { resetVideoSupport } from '#lib/ui/video-support.js';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { setSystemBarsHidden } from '#lib/platform/system-bars.js';

const imageItem: MediaItem = {
  kind: 'image',
  html: null,
  filename: 'photo.png',
  caption: null,
  source: 'mxc://example.org/image',
  mime: 'image/png',
  width: 1600,
  height: 900,
  size: null,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
  animated: null,
  eventId: '$image',
  sender: 'Alice',
};

const videoItem: MediaItem = {
  kind: 'video',
  html: null,
  filename: 'clip.mp4',
  caption: null,
  source: 'mxc://example.org/video',
  mime: 'video/mp4',
  width: 640,
  height: 360,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
  eventId: '$video',
  sender: 'Alice',
};

const audioItem: MediaItem = {
  kind: 'audio',
  html: null,
  duration_ms: null,
  waveform: null,
  voice: false,
  metadata: null,
  filename: 'voice.ogg',
  caption: null,
  source: 'mxc://example.org/audio',
  mime: 'audio/ogg',
  eventId: '$audio',
  sender: 'Alice',
};

function stubRects(container: DOMRect, content: DOMRect): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('stage')) return container;
    if (this.tagName === 'IMG') return content;
    return new DOMRect();
  });
}

function rect(width: number, height: number): DOMRect {
  return new DOMRect(0, 0, width, height);
}

afterEach(() => {
  core.fetchMedia.mockReset();
  vi.restoreAllMocks();
});

const user = userEvent.setup();

function stage(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.stage');
  if (!element) throw new Error('viewer stage missing');
  return element;
}

async function openImage(
  items: MediaItem[] = [imageItem],
  onClose = () => {}
): Promise<HTMLElement> {
  render(MediaViewer, { items, selectedEventId: '$image', onClose });
  return screen.findByRole('img');
}

async function swipe(from: number, to: number): Promise<void> {
  await user.pointer([
    { keys: '[TouchA>]', target: stage(), coords: { clientX: 100, clientY: from } },
    { pointerName: 'TouchA', target: stage(), coords: { clientX: 100, clientY: to } },
  ]);
}

test('renders a video attachment with a player and no zoom controls', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaViewer, { items: [videoItem], selectedEventId: '$video', onClose: () => {} });

  await vi.waitFor(() => {
    expect(document.querySelector('video')).toBeInTheDocument();
  });

  expect(screen.queryByRole('button', { name: 'viewer.zoomIn' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'viewer.reset' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'viewer.downloadVideo' })).toBeInTheDocument();
});

test('a spoiler opened in the viewer loads blurred without exposing its caption', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaViewer, {
    items: [
      {
        ...imageItem,
        caption: 'Secret ending',
        source: 'mxc://example.org/spoiler',
        spoiler: 'Ending',
      },
    ],
    selectedEventId: '$image',
    onClose: () => {},
  });
  await tick();
  await vi.waitFor(() => {
    expect(document.querySelector('.stage img.spoilered')).toBeInTheDocument();
  });
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/spoiler', 0, 0);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.queryByText(/photo\.png/)).not.toBeInTheDocument();
  expect(screen.queryByText('Secret ending')).not.toBeInTheDocument();

  const reveal = screen.getByRole('button', { name: 'timeline.revealImage:photo.png' });
  expect(reveal).toHaveAccessibleDescription('Ending');
  await user.click(reveal);
  expect(await screen.findByRole('img')).toBeInTheDocument();
  expect(document.querySelector('.stage img')).not.toHaveClass('spoilered');
});

test('an ordinary viewer image can be locally hidden and revealed without closing', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  await openImage([imageItem], onClose);
  expect(document.querySelector('.stage .media-image-spoiler')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'timeline.hideImageUnnamed' }));
  expect(document.querySelector('.stage img')).toHaveClass('spoilered');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'timeline.revealImage:photo.png' }));
  expect(await screen.findByRole('img')).not.toHaveClass('spoilered');
  expect(document.querySelector('.stage .media-image-spoiler')).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

test('a hidden video still waits for reveal before fetching', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaViewer, {
    items: [{ ...videoItem, spoiler: 'Ending' }],
    selectedEventId: '$video',
    onClose: () => {},
  });
  await tick();
  expect(core.fetchMedia).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /Ending/ }));
  await vi.waitFor(() => expect(document.querySelector('video')).toBeInTheDocument());
});

test('renders an audio attachment with a player', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaViewer, { items: [audioItem], selectedEventId: '$audio', onClose: () => {} });

  await vi.waitFor(() => {
    expect(document.querySelector('audio')).toBeInTheDocument();
  });

  expect(screen.getByRole('button', { name: 'viewer.downloadAudio' })).toBeInTheDocument();
});

test('jumps to the selected message from More', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onJump = vi.fn();
  render(MediaViewer, {
    items: [imageItem],
    selectedEventId: '$image',
    onClose: vi.fn(),
    onJump,
  });

  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'viewer.jumpToMessage' }));

  expect(onJump).toHaveBeenCalledExactlyOnceWith('$image');
});

test('right-clicking the image offers to copy it and confirms the copy', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(new Blob(['x'], { type: 'image/png' }))
  );
  const write = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue();
  const info = vi.spyOn(toasts, 'info');
  const img = await openImage();

  await user.pointer({ keys: '[MouseRight]', target: img });
  await user.click(await screen.findByRole('menuitem', { name: 'viewer.copyImage' }));

  await vi.waitFor(() => {
    expect(info).toHaveBeenCalledWith('viewer.imageCopied');
  });
  expect(write).toHaveBeenCalledOnce();
});

test('escape in the image menu closes the menu, not the viewer', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const img = await openImage([imageItem], onClose);

  await user.pointer({ keys: '[MouseRight]', target: img });
  await screen.findByRole('menuitem', { name: 'viewer.copyImage' });
  await user.keyboard('{Escape}');

  expect(onClose).not.toHaveBeenCalled();
});

test('backdrop click closes the viewer', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const img = await openImage([imageItem], onClose);

  await user.click(img);
  await user.click(screen.getByText('Alice'));
  await user.pointer({ keys: '[MouseRight]', target: stage() });
  expect(onClose).not.toHaveBeenCalled();

  await user.click(stage());
  expect(onClose).toHaveBeenCalledOnce();
});

test('backdrop drag keeps the viewer open', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const img = await openImage([imageItem], onClose);

  await user.pointer([
    { keys: '[MouseLeft>]', target: stage(), coords: { clientX: 50, clientY: 50 } },
    { target: stage(), coords: { clientX: 150, clientY: 50 } },
    { target: stage(), coords: { clientX: 50, clientY: 50 } },
    { keys: '[/MouseLeft]', target: stage() },
  ]);
  await user.pointer([
    { keys: '[MouseLeft>]', target: img },
    { keys: '[/MouseLeft]', target: stage() },
  ]);

  expect(onClose).not.toHaveBeenCalled();
});

test('cancelled backdrop press keeps the viewer open', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  await openImage([imageItem], onClose);

  await fireEvent.pointerDown(stage(), { pointerId: 1, pointerType: 'mouse', button: 0 });
  await fireEvent.pointerCancel(stage(), { pointerId: 1, pointerType: 'mouse' });
  await fireEvent.pointerUp(stage(), { pointerId: 1, pointerType: 'mouse', button: 0 });

  expect(onClose).not.toHaveBeenCalled();
});

test('clamps pointer drag panning to the zoomed overflow', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const img = await openImage();

  await user.click(screen.getByRole('button', { name: 'viewer.zoomIn' }));
  await user.pointer([
    { keys: '[MouseLeft>]', target: stage(), coords: { clientX: 0, clientY: 0 } },
    { target: stage(), coords: { clientX: -5000, clientY: -5000 } },
  ]);

  expect(img.style.transform).toContain('translate(-400px, -300px)');

  await user.pointer({ keys: '[/MouseLeft]', target: stage() });
  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'viewer.reset' }));

  expect(img.style.transform).toContain('translate(0px, 0px)');
});

test('arrow keys pan when zoomed and navigate otherwise', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const img = await openImage([imageItem, videoItem]);

  await user.click(screen.getByRole('button', { name: 'viewer.zoomIn' }));
  await user.keyboard('{ArrowRight}');

  expect(img.style.transform).toContain('translate(-40px, 0px)');
  expect(screen.getByText('Alice')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'viewer.reset' }));
  await user.keyboard('{ArrowRight}');

  await vi.waitFor(() => {
    expect(document.querySelector('video')).toBeInTheDocument();
  });
});

test('takes a typed zoom percentage', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const img = await openImage();

  await user.click(screen.getByRole('button', { name: '100%' }));

  const input = screen.getByRole('textbox', { name: 'viewer.setZoom' });
  expect(input).toHaveValue('100');
  await user.clear(input);
  await user.type(input, '250{Enter}');

  expect(img.style.transform).toContain('scale(2.5)');
  expect(screen.getByRole('button', { name: '250%' })).toBeInTheDocument();
});

test('double click zooms in, and again returns to the fitted size', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(1_000);
  const img = await openImage();

  const tap = () =>
    user.pointer({ keys: '[MouseLeft]', target: img, coords: { clientX: 400, clientY: 300 } });

  await tap();
  clock.mockReturnValue(1_100);
  await tap();

  expect(img.style.transform).toContain('scale(2)');

  clock.mockReturnValue(2_000);
  await tap();
  clock.mockReturnValue(2_100);
  await tap();

  expect(img.style.transform).toContain('scale(1)');
});

test('a single tap goes immersive, and another brings the bars back', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  await openImage([imageItem, videoItem]);
  const toolbar = document.querySelector('.toolbar');

  await user.pointer({ keys: '[TouchA]', target: stage(), coords: { clientX: 400, clientY: 300 } });
  await vi.waitFor(() => {
    expect(toolbar).toHaveClass('chrome-hidden');
  });
  expect(stage()).toHaveClass('chrome-hidden');
  expect(document.querySelector('.bottom-bar')).not.toBeInTheDocument();
  expect(document.querySelector('.viewer')).toHaveClass('immersive');
  expect(setSystemBarsHidden).toHaveBeenLastCalledWith(true);

  await user.pointer({ keys: '[TouchA]', target: stage(), coords: { clientX: 400, clientY: 300 } });
  await vi.waitFor(() => {
    expect(toolbar).not.toHaveClass('chrome-hidden');
  });
  expect(setSystemBarsHidden).toHaveBeenLastCalledWith(false);
});

test('a double tap zooms without hiding the bars', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(1_000);
  const img = await openImage();
  const tap = () =>
    user.pointer({ keys: '[TouchA]', target: stage(), coords: { clientX: 400, clientY: 300 } });

  await tap();
  clock.mockReturnValue(1_100);
  await tap();
  await new Promise((resolve) => setTimeout(resolve, 400));

  expect(img.style.transform).toContain('scale(2)');
  expect(document.querySelector('.toolbar')).not.toHaveClass('chrome-hidden');
});

test('a downward swipe past the threshold dismisses the viewer', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const img = await openImage([imageItem], onClose);

  await swipe(100, 220);

  expect(img.style.transform).toContain('translate(0px, 120px)');

  await user.pointer({ keys: '[/TouchA]', target: stage() });
  expect(onClose).toHaveBeenCalled();
});

test('a short swipe springs back instead of dismissing', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const img = await openImage([imageItem], onClose);

  await swipe(100, 130);
  await user.pointer({ keys: '[/TouchA]', target: stage() });

  expect(onClose).not.toHaveBeenCalled();
  expect(img.style.transform).toContain('translate(0px, 0px)');
});

test('closes instead of throwing when the selected media is no longer in the timeline', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  render(MediaViewer, { items: [], selectedEventId: '$image', onClose });

  await tick();

  expect(onClose).toHaveBeenCalled();
  expect(core.fetchMedia).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('revokes the re-encoded stream when the viewer closes', async () => {
  resetVideoSupport();
  resetVideoStreaming();
  vi.spyOn(window.HTMLVideoElement.prototype, 'canPlayType').mockReturnValue('');
  let next = 0;
  const revoked: string[] = [];
  vi.stubGlobal(
    'URL',
    Object.assign(globalThis.URL, {
      createObjectURL: () => `blob:stream-${String(next++)}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    })
  );
  Object.assign(core, {
    streamVideo: vi.fn((_source: string, _id: number, onChunk: (chunk: Uint8Array) => void) => {
      onChunk(new Uint8Array([1]));
      return Promise.resolve();
    }),
    videoStreamMime: vi.fn(() => Promise.resolve('video/webm; codecs="vp9,opus"')),
  });

  try {
    const { unmount } = render(MediaViewer, {
      items: [videoItem],
      selectedEventId: '$video',
      onClose: () => {},
    });
    await vi.waitFor(() => {
      expect(document.querySelector('video')?.getAttribute('src')).toBe('blob:stream-0');
    });
    expect(revoked).toEqual([]);

    unmount();

    expect(revoked).toEqual(['blob:stream-0']);
  } finally {
    vi.unstubAllGlobals();
    delete (core as Record<string, unknown>).streamVideo;
    delete (core as Record<string, unknown>).videoStreamMime;
    resetVideoSupport();
    resetVideoStreaming();
  }
});
