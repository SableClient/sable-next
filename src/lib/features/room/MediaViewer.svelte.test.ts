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
  html: null,
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
  html: null,
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
  html: null,
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
  expect(document.querySelector('[aria-label="viewer.downloadVideo"]')).not.toBeNull();
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
  expect(document.querySelector('[aria-label="viewer.downloadAudio"]')).not.toBeNull();
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

  document.querySelector<HTMLButtonElement>('[aria-label="viewer.zoomIn"]')?.click();
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

  document.querySelector<HTMLButtonElement>('[aria-label="viewer.zoomIn"]')?.click();
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

test('takes a typed zoom percentage', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [imageItem], selectedEventId: '$image', onClose: () => {} },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('img')).not.toBeNull();
  });

  document.querySelector<HTMLButtonElement>('button.zoom-level')?.click();
  await tick();

  const input = document.querySelectorAll<HTMLInputElement>('.zoom-level input')[0];
  expect(input.value).toBe('100');
  input.value = '250';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();

  expect(document.querySelector('img')?.style.transform).toContain('scale(2.5)');
  expect(document.querySelector('button.zoom-level')?.textContent).toBe('250%');
  await unmount(instance);
});

test('double click zooms in, and again returns to the fitted size', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(1_000);
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [imageItem], selectedEventId: '$image', onClose: () => {} },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('img')).not.toBeNull();
  });
  const stage = document.querySelectorAll('.stage')[0];

  const tap = (): void => {
    stage.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 400, clientY: 300, bubbles: true })
    );
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  };

  tap();
  clock.mockReturnValue(1_100);
  tap();
  await tick();

  expect(document.querySelector('img')?.style.transform).toContain('scale(2)');

  clock.mockReturnValue(2_000);
  tap();
  clock.mockReturnValue(2_100);
  tap();
  await tick();

  expect(document.querySelector('img')?.style.transform).toContain('scale(1)');
  await unmount(instance);
});

test('a downward swipe past the threshold dismisses the viewer', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [imageItem], selectedEventId: '$image', onClose },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('img')).not.toBeNull();
  });
  const stage = document.querySelectorAll('.stage')[0];

  stage.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
      bubbles: true,
    })
  );
  stage.dispatchEvent(
    new PointerEvent('pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 220,
      bubbles: true,
    })
  );
  await tick();

  expect(document.querySelector('img')?.style.transform).toContain('translate(0px, 120px)');

  stage.dispatchEvent(
    new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', bubbles: true })
  );
  expect(onClose).toHaveBeenCalled();

  await unmount(instance);
});

test('a short swipe springs back instead of dismissing', async () => {
  stubRects(rect(800, 600), rect(1600, 1200));
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [imageItem], selectedEventId: '$image', onClose },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('img')).not.toBeNull();
  });
  const stage = document.querySelectorAll('.stage')[0];

  stage.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
      bubbles: true,
    })
  );
  stage.dispatchEvent(
    new PointerEvent('pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 130,
      bubbles: true,
    })
  );
  stage.dispatchEvent(
    new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', bubbles: true })
  );
  await tick();

  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('img')?.style.transform).toContain('translate(0px, 0px)');

  await unmount(instance);
});

test('closes instead of throwing when the selected media is no longer in the timeline', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onClose = vi.fn();
  const instance = mount(MediaViewer, {
    target: document.body,
    props: { items: [], selectedEventId: '$image', onClose },
  });

  await tick();

  expect(onClose).toHaveBeenCalled();
  expect(core.fetchMedia).not.toHaveBeenCalled();
  expect(document.querySelector('.stage')).toBeNull();
  await unmount(instance);
});
