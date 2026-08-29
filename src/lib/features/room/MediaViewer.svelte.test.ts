// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { MediaItem } from './MediaViewer.svelte';

const core = vi.hoisted(() => {
  const fetchMedia = vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>();

  return { fetchMedia, commands: { fetchMedia } };
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));
vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));

import MediaViewer from './MediaViewer.svelte';

const imageItem: MediaItem = {
  kind: 'image',
  body: 'photo.png',
  source: 'mxc://example.org/image',
  filename: 'photo.png',
  mime: 'image/png',
  width: 1600,
  height: 900,
  blurhash: null,
  spoiler: null,
  eventId: '$image',
  sender: 'Alice',
};

const videoItem: MediaItem = {
  kind: 'video',
  body: 'clip.mp4',
  source: 'mxc://example.org/video',
  mime: 'video/mp4',
  width: 640,
  height: 360,
  blurhash: null,
  spoiler: null,
  eventId: '$video',
  sender: 'Alice',
};

const audioItem: MediaItem = {
  kind: 'audio',
  duration_ms: null,
  waveform: null,
  voice: false,
  body: 'voice.ogg',
  source: 'mxc://example.org/audio',
  mime: 'audio/ogg',
  eventId: '$audio',
  sender: 'Alice',
};

function stubRects(container: DOMRect, content: DOMRect): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('stage')) return container;
      if (this.tagName === 'IMG') return content;
      return new DOMRect();
    }
  );
}

function rect(width: number, height: number): DOMRect {
  return new DOMRect(0, 0, width, height);
}

afterEach(() => {
  core.fetchMedia.mockReset();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('renders a video attachment with a player and no zoom controls', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [videoItem], selectedEventId: '$video', onClose: () => {} },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('video')).not.toBeNull();
  expect(document.querySelector('.zoom-controls')).toBeNull();
  expect(document.querySelector('.reset')).toBeNull();
  expect(document.querySelector('[aria-label="Download video"]')).not.toBeNull();
  await unmount(instance);
});

test('renders an audio attachment with a player', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [audioItem], selectedEventId: '$audio', onClose: () => {} },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(document.querySelector('audio')).not.toBeNull();
  expect(document.querySelector('[aria-label="Download audio"]')).not.toBeNull();
  await unmount(instance);
});

test('clamps pointer drag panning to the zoomed overflow', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [imageItem], selectedEventId: '$image', onClose: () => {} },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('img')).not.toBeNull();
  });
  const img = document.querySelector('img');
  const stage = document.querySelector('.stage');
  expect(stage).not.toBeNull();

  document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
  await tick();

  stage?.dispatchEvent(
    new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, bubbles: true })
  );
  stage?.dispatchEvent(
    new PointerEvent('pointermove', {
      pointerId: 1,
      clientX: -5000,
      clientY: -5000,
      bubbles: true,
    })
  );
  await tick();

  expect(img?.style.transform).toContain('translate(-400px, -300px)');

  stage?.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  document.querySelector<HTMLButtonElement>('.reset')?.click();
  await tick();

  expect(img?.style.transform).toContain('translate(0px, 0px)');
  await unmount(instance);
});

test('arrow keys pan when zoomed and navigate otherwise', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaViewer, {
    target: document.body,
    props: {
      items: [imageItem, videoItem],
      selectedEventId: '$image',
      onClose: () => {},
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('img')).not.toBeNull();
  });

  document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
  await tick();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  await tick();

  const img = document.querySelector('img');
  expect(img?.style.transform).toContain('translate(-40px, 0px)');
  expect(document.querySelector('strong')?.textContent).toBe('Alice');

  document.querySelector<HTMLButtonElement>('.reset')?.click();
  await tick();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

  await vi.waitFor(() => {
    expect(document.querySelector('video')).not.toBeNull();
  });
  await unmount(instance);
});
