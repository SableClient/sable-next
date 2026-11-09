// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { MediaItem } from '#lib/ui/media/media-viewer-types.js';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/platform/system-bars.js', () => ({ setSystemBarsHidden: vi.fn() }));

import * as files from '#lib/platform/files.js';
import * as platformOs from '#lib/platform/os.js';

import MediaViewer from './MediaViewer.svelte';
import { spoilerVisibility, spoilerVisibilityKey } from './spoiler-visibility.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { imageItem as timelineImage } from '#lib/features/room/timeline/timeline-item-fixtures.js';
import { setSystemBarsHidden } from '#lib/platform/system-bars.js';
import { mediaViewerState as viewer } from './media-viewer-state.svelte.js';

const imageItem: MediaItem = {
  kind: 'image',
  html: null,
  filename: 'photo.png',
  caption: null,
  source: 'mxc://example.org/image',
  external_url: null,
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
  external_url: null,
  mime: 'video/mp4',
  width: 640,
  height: 360,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
  playback: null,
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
  external_url: null,
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

const originalViewerClose = viewer.close.bind(viewer);

afterEach(() => {
  spoilerVisibility.clear();
  core.fetchMedia.mockReset();
  vi.restoreAllMocks();
  viewer.close = originalViewerClose;
  viewer.close();
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
  viewer.items = items;
  viewer.eventId = '$image';
  viewer.close = onClose;
  render(MediaViewer);
  return screen.findByRole('img');
}

async function swipe(from: number, to: number): Promise<void> {
  await user.pointer([
    { keys: '[TouchA>]', target: stage(), coords: { clientX: 100, clientY: from } },
    { pointerName: 'TouchA', target: stage(), coords: { clientX: 100, clientY: to } },
  ]);
}

async function openMobileImage(os: 'android' | 'ios') {
  vi.spyOn(platformOs, 'isNativeMobile').mockReturnValue(true);
  vi.spyOn(platformOs, 'isAndroid').mockReturnValue(os === 'android');
  vi.spyOn(files, 'supportsPhotoLibrary').mockResolvedValue(true);
  const photos = vi.spyOn(files, 'saveImageToPhotos').mockResolvedValue('saved');
  const download = vi.spyOn(files, 'saveUrl').mockResolvedValue('saved');
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  await openImage();
  return { photos, download };
}

test('iOS saves to Photos with one tap and labels the button accordingly', async () => {
  const { photos, download } = await openMobileImage('ios');
  await user.click(screen.getByRole('button', { name: 'viewer.saveToPhotos' }));
  expect(photos).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^blob:/),
    'photo.png',
    'image/png'
  );
  expect(download).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('Android downloads an image with one tap', async () => {
  const { photos, download } = await openMobileImage('android');
  await user.click(screen.getByRole('button', { name: 'viewer.downloadImage' }));
  expect(download).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^blob:/),
    'photo.png',
    true
  );
  expect(photos).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('both save destinations remain available in More actions', async () => {
  const { photos, download } = await openMobileImage('ios');
  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(screen.getByRole('menuitem', { name: 'viewer.saveToFiles' }));
  expect(download).toHaveBeenCalledOnce();
  expect(photos).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(screen.getByRole('menuitem', { name: 'viewer.saveToPhotos' }));
  expect(photos).toHaveBeenCalledOnce();
  expect(download).toHaveBeenCalledOnce();
});

test('the iOS image context menu uses the same Photos save action', async () => {
  const { photos, download } = await openMobileImage('ios');
  await fireEvent.contextMenu(screen.getByRole('img'));
  await user.click(screen.getByRole('menuitem', { name: 'viewer.saveToPhotos' }));
  expect(photos).toHaveBeenCalledOnce();
  expect(download).not.toHaveBeenCalled();
});

test('iOS video viewer saves to Photos and offers saving to Files', async () => {
  vi.spyOn(platformOs, 'isNativeMobile').mockReturnValue(true);
  vi.spyOn(platformOs, 'isAndroid').mockReturnValue(false);
  vi.spyOn(files, 'supportsPhotoLibrary').mockResolvedValue(true);
  const photos = vi.spyOn(files, 'saveVideoToPhotos').mockResolvedValue('saved');
  const download = vi.spyOn(files, 'saveUrl').mockResolvedValue('saved');
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  viewer.items = [videoItem];
  viewer.eventId = '$video';
  render(MediaViewer);
  await vi.waitFor(() => {
    expect(document.querySelector('video')).toBeInTheDocument();
  });
  await user.click(screen.getByRole('button', { name: 'viewer.saveToPhotos' }));
  expect(photos).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(screen.getByRole('menuitem', { name: 'viewer.saveToFiles' }));
  expect(download).toHaveBeenCalledOnce();
});

test('renders a video attachment with a player and no zoom controls', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  viewer.items = [videoItem];
  viewer.eventId = '$video';
  render(MediaViewer);

  await vi.waitFor(() => {
    expect(document.querySelector('video')).toBeInTheDocument();
  });

  expect(screen.queryByRole('button', { name: 'viewer.zoomIn' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'viewer.reset' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'viewer.downloadVideo' })).toBeInTheDocument();
});

test('a spoiler opened in the viewer loads blurred without exposing its caption', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  viewer.items = [
    {
      ...imageItem,
      caption: 'Secret ending',
      source: 'mxc://example.org/spoiler',
      spoiler: 'Ending',
    },
  ];
  viewer.eventId = '$image';
  render(MediaViewer);
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

test('a spoiler already revealed in the timeline opens unblurred', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  spoilerVisibility.set(
    spoilerVisibilityKey('$image', 'mxc://example.org/spoiler', 'Ending'),
    false
  );
  viewer.items = [{ ...imageItem, source: 'mxc://example.org/spoiler', spoiler: 'Ending' }];
  viewer.eventId = '$image';
  render(MediaViewer);
  expect(await screen.findByRole('img')).not.toHaveClass('spoilered');
  expect(document.querySelector('.stage .media-image-spoiler')).not.toBeInTheDocument();
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
  viewer.items = [{ ...videoItem, spoiler: 'Ending' }];
  viewer.eventId = '$video';
  render(MediaViewer);
  await tick();
  expect(core.fetchMedia).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /Ending/ }));
  await vi.waitFor(() => {
    expect(document.querySelector('video')).toBeInTheDocument();
  });
});

test('renders an audio attachment with a player', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  viewer.items = [audioItem];
  viewer.eventId = '$audio';
  render(MediaViewer);

  await vi.waitFor(() => {
    expect(document.querySelector('audio')).toBeInTheDocument();
  });

  expect(screen.getByRole('button', { name: 'viewer.downloadAudio' })).toBeInTheDocument();
});

test('jumps to the selected message from More', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onJump = vi.fn();
  viewer.openPanel([imageItem], '$image', onJump);
  render(MediaViewer);

  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'common.jumpToMessage' }));

  await vi.waitFor(() => {
    expect(onJump).toHaveBeenCalledExactlyOnceWith('$image');
  });
  expect(viewer.eventId).toBeNull();
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

test('Ctrl+C copies the open image', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(new Blob(['x'], { type: 'image/png' }))
  );
  const write = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue();
  await openImage();

  await user.keyboard('{Control>}c{/Control}');

  await vi.waitFor(() => {
    expect(write).toHaveBeenCalledOnce();
  });
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

test('the lens zooms and resizes with a horizontal wheel', async () => {
  stubRects(rect(800, 600), rect(800, 600));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const img = await openImage();
  const lens = () => document.querySelector<HTMLElement>('.lens');
  const lensImage = () => document.querySelector<HTMLElement>('.lens img');

  await user.pointer({
    keys: '[MouseLeft>]',
    target: img,
    coords: { clientX: 200, clientY: 150 },
  });

  expect(lens()?.style.left).toBe('104px');
  expect(lens()?.style.width).toBe('192px');
  expect(lensImage()?.style.width).toBe('1600px');
  expect(lensImage()?.style.transform).toBe('translate(-304px, -204px)');

  await user.pointer({ target: img, coords: { clientX: 400, clientY: 300 } });
  expect(lensImage()?.style.transform).toBe('translate(-704px, -504px)');

  await fireEvent.wheel(stage(), { deltaX: -100 });
  expect(lensImage()?.style.width).toBe('1760px');
  expect(img.style.transform).toContain('scale(1)');

  const shiftWheel = new WheelEvent('wheel', { deltaX: -100, bubbles: true, cancelable: true });
  Object.defineProperty(shiftWheel, 'shiftKey', { value: true });
  await fireEvent(stage(), shiftWheel);
  expect(parseFloat(lens()?.style.width ?? '')).toBeCloseTo(211.2);
  expect(lensImage()?.style.width).toBe('1760px');

  await user.pointer({ keys: '[/MouseLeft]', target: img });
  expect(lens()).toBeNull();
});

test('the lens keeps its size and zoom for the next image', async () => {
  stubRects(rect(800, 600), rect(800, 600));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const lens = () => document.querySelector<HTMLElement>('.lens');
  const lensImage = () => document.querySelector<HTMLElement>('.lens img');
  const hold = async (img: HTMLElement) =>
    user.pointer({ keys: '[MouseLeft>]', target: img, coords: { clientX: 200, clientY: 150 } });

  viewer.items = [imageItem];
  viewer.eventId = '$image';
  const first = render(MediaViewer);
  await hold(await screen.findByRole('img'));
  const size = lens()?.style.width;
  const zoomed = lensImage()?.style.width;
  await fireEvent.wheel(stage(), { deltaY: -100 });
  const shiftWheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
  Object.defineProperty(shiftWheel, 'shiftKey', { value: true });
  await fireEvent(stage(), shiftWheel);
  const tunedSize = lens()?.style.width;
  const tunedZoom = lensImage()?.style.width;
  expect(tunedSize).not.toBe(size);
  expect(tunedZoom).not.toBe(zoomed);
  first.unmount();

  viewer.items = [imageItem];
  viewer.eventId = '$image';
  render(MediaViewer);
  await hold(await screen.findByRole('img'));

  expect(lens()?.style.width).toBe(tunedSize);
  expect(lensImage()?.style.width).toBe(tunedZoom);
});

test('a zoomed image pans under the mouse instead of showing the lens', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const img = await openImage();

  await user.click(screen.getByRole('button', { name: 'viewer.zoomIn' }));
  await user.pointer([
    { keys: '[MouseLeft>]', target: img, coords: { clientX: 100, clientY: 100 } },
    { target: img, coords: { clientX: 60, clientY: 100 } },
  ]);

  expect(document.querySelector('.lens')).toBeNull();
  expect(img.style.transform).toContain('translate(-40px, 0px)');
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
  viewer.items = [];
  viewer.eventId = '$image';
  viewer.close = onClose;
  render(MediaViewer);

  await tick();

  expect(onClose).toHaveBeenCalled();
  expect(core.fetchMedia).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('ctrl-wheel zooms the image in noticeably and back out', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const img = await openImage();
  const zoomIn = new WheelEvent('wheel', { deltaY: -7, bubbles: true, cancelable: true });
  Object.defineProperty(zoomIn, 'ctrlKey', { value: true });

  await fireEvent(stage(), zoomIn);

  expect(Number(img.style.transform.match(/scale\(([^)]+)\)/)?.[1])).toBeGreaterThan(1.05);

  const zoomOut = new WheelEvent('wheel', { deltaY: 7, bubbles: true, cancelable: true });
  Object.defineProperty(zoomOut, 'ctrlKey', { value: true });
  await fireEvent(stage(), zoomOut);

  expect(img.style.transform).toContain('scale(1)');
});

test('updates the selected image without remounting', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  viewer.openPanel(
    [imageItem, { ...imageItem, eventId: '$second', source: 'mxc://example.org/second' }],
    '$image'
  );
  render(MediaViewer);
  await screen.findByRole('dialog');
  viewer.eventId = '$second';
  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/second', 0, 0);
  });
  viewer.openStandalone('mxc://example.org/avatar', 'Bob');
  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/avatar', 0, 0);
  });
  expect(screen.getByRole('dialog')).toHaveTextContent('Bob');
});

test('closes when the displayed media is removed from the timeline', async () => {
  let entries = $state([timelineImage()]);
  viewer.open('$item', () => entries);
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MediaViewer);
  await screen.findByRole('dialog');
  entries = [];
  await vi.waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(viewer.eventId).toBeNull();
});

test('clears the jump action when standalone media replaces timeline media', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  viewer.openPanel([imageItem], '$image', vi.fn());
  render(MediaViewer);
  await screen.findByRole('dialog');
  viewer.openStandalone('mxc://example.org/profile', 'Bob');
  await user.click(screen.getByRole('button', { name: 'timeline.moreActions' }));
  expect(screen.queryByRole('menuitem', { name: 'common.jumpToMessage' })).not.toBeInTheDocument();
});
