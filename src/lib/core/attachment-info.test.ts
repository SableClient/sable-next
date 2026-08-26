import { afterEach, expect, test, vi } from 'vitest';

import { measureAttachment } from './attachment-info.js';

function file(mime: string): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: mime });
}

/** happy-dom decodes nothing, so the element has to be driven by hand. */
function stubMediaElement(overrides: {
  videoWidth?: number;
  videoHeight?: number;
  duration?: number;
  fail?: boolean;
}) {
  const element = {
    preload: '',
    muted: false,
    videoWidth: overrides.videoWidth,
    videoHeight: overrides.videoHeight,
    duration: overrides.duration ?? Number.NaN,
    listeners: new Map<string, () => void>(),
    addEventListener(name: string, handler: () => void) {
      this.listeners.set(name, handler);
    },
    removeAttribute() {},
    load() {},
    set src(_value: string) {
      // The browser fires this a tick after the source is set.
      queueMicrotask(() => this.listeners.get(overrides.fail ? 'error' : 'loadedmetadata')?.());
    },
  };

  if (overrides.videoWidth === undefined) {
    delete (element as { videoWidth?: number }).videoWidth;
    delete (element as { videoHeight?: number }).videoHeight;
  }

  vi.spyOn(document, 'createElement').mockReturnValue(element as unknown as HTMLElement);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return element;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('an image reports the decoded dimensions', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: 1280, height: 720, close: () => {} }))
  );

  await expect(measureAttachment(file('image/png'))).resolves.toEqual({
    width: 1280,
    height: 720,
    duration_ms: null,
    animated: false,
  });
});

test('a GIF is animated, and a WebP is left undecided', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: 8, height: 8, close: () => {} }))
  );

  await expect(measureAttachment(file('image/gif'))).resolves.toMatchObject({ animated: true });
  await expect(measureAttachment(file('image/webp'))).resolves.toMatchObject({ animated: null });
});

test('an undecodable image measures nothing rather than throwing', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.reject(new Error('not an image')))
  );

  await expect(measureAttachment(file('image/png'))).resolves.toBeNull();
});

test('a video reports dimensions and a duration in milliseconds', async () => {
  stubMediaElement({ videoWidth: 1920, videoHeight: 1080, duration: 12.34 });

  await expect(measureAttachment(file('video/mp4'))).resolves.toEqual({
    width: 1920,
    height: 1080,
    duration_ms: 12_340,
    animated: null,
  });
});

test('a live stream reporting an infinite duration measures nothing', async () => {
  stubMediaElement({ videoWidth: 0, videoHeight: 0, duration: Number.POSITIVE_INFINITY });

  await expect(measureAttachment(file('video/mp4'))).resolves.toBeNull();
});

test('audio reports a duration and no dimensions', async () => {
  stubMediaElement({ duration: 5 });

  await expect(measureAttachment(file('audio/ogg'))).resolves.toEqual({
    width: null,
    height: null,
    duration_ms: 5000,
    animated: null,
  });
});

test('media the browser rejects measures nothing rather than throwing', async () => {
  stubMediaElement({ duration: 5, fail: true });

  await expect(measureAttachment(file('audio/ogg'))).resolves.toBeNull();
});

test('a document is not measured at all', async () => {
  const createElement = vi.spyOn(document, 'createElement');

  await expect(measureAttachment(file('application/pdf'))).resolves.toBeNull();
  expect(createElement).not.toHaveBeenCalled();
});
