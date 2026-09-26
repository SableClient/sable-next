import { afterEach, expect, test, vi } from 'vitest';

import { markVoiceRecording, measureAttachment, readAudioTags } from './attachment-info.js';

function file(mime: string): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: mime });
}

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
    blurhash: null,
    waveform: null,
    voice: false,
    audio_metadata: null,
  });
});

test('a decodable image gets a blurhash', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: 8, height: 8, close: () => {} }))
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(128),
      width,
      height,
    }),
  } as unknown as CanvasRenderingContext2D);

  const result = await measureAttachment(file('image/png'));
  expect(typeof result?.blurhash).toBe('string');
  expect(result?.blurhash).not.toBeNull();
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
    blurhash: null,
    waveform: null,
    voice: false,
    audio_metadata: null,
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
    blurhash: null,
    waveform: null,
    voice: false,
    audio_metadata: null,
  });
});

test('media the browser rejects measures nothing rather than throwing', async () => {
  stubMediaElement({ duration: 5, fail: true });

  await expect(measureAttachment(file('audio/ogg'))).resolves.toBeNull();
});

test('a file marked as a voice recording carries its waveform', async () => {
  stubMediaElement({ duration: 5 });

  const recording = new File([new Uint8Array([1, 2, 3])], 'voice.webm', { type: 'audio/webm' });
  markVoiceRecording(recording, [0, 0.5, 1]);

  await expect(measureAttachment(recording)).resolves.toEqual({
    width: null,
    height: null,
    duration_ms: 5000,
    animated: null,
    blurhash: null,
    waveform: [0, 0.5, 1],
    voice: true,
    audio_metadata: null,
  });
});

test('a document is not measured at all', async () => {
  const createElement = vi.spyOn(document, 'createElement');

  await expect(measureAttachment(file('application/pdf'))).resolves.toBeNull();
  expect(createElement).not.toHaveBeenCalled();
});

function id3(frames: Record<string, string>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const body = Object.entries(frames).flatMap(([id, text]) => {
    const value = [0, ...encoder.encode(text)];
    const size = value.length;
    return [
      ...encoder.encode(id),
      (size >>> 24) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 8) & 0xff,
      size & 0xff,
      0,
      0,
      ...value,
    ];
  });
  const size = body.length;
  const header = [
    ...encoder.encode('ID3'),
    3,
    0,
    0,
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f,
  ];
  return new Uint8Array([...header, ...body]);
}

test('reads the title, artist and album tags of a music file', async () => {
  const file = new File(
    [id3({ TIT2: 'Moonwalker', TPE1: 'Jake Chudnow', TALB: 'The Moon' })],
    'moon.mp3',
    {
      type: 'audio/mpeg',
    }
  );

  expect(await readAudioTags(file)).toEqual({
    title: 'Moonwalker',
    artist: 'Jake Chudnow',
    album: 'The Moon',
    cover_art: null,
  });
  expect(
    await readAudioTags(new File([new Uint8Array(8)], 'x.mp3', { type: 'audio/mpeg' }))
  ).toBeNull();
});
