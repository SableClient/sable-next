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
      queueMicrotask(() => {
        if (overrides.fail) this.listeners.get('error')?.();
        else {
          this.listeners.get('loadedmetadata')?.();
          this.listeners.get('loadeddata')?.();
        }
      });
    },
  };

  if (overrides.videoWidth === undefined) {
    delete (element as { videoWidth?: number }).videoWidth;
    delete (element as { videoHeight?: number }).videoHeight;
  }

  const canvas = document.createElement('canvas');
  vi.spyOn(document, 'createElement').mockImplementation((name) =>
    name === 'canvas' ? canvas : (element as unknown as HTMLElement)
  );
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
    info: {
      width: 1280,
      height: 720,
      duration_ms: null,
      animated: null,
      blurhash: null,
      waveform: null,
      voice: false,
      audio_metadata: null,
      gif: null,
    },
    thumbnail: null,
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
  expect(typeof result.info?.blurhash).toBe('string');
  expect(result.info?.blurhash).not.toBeNull();
});

test('a file is measured once however many times it is asked for', async () => {
  const decode = vi.fn(() => Promise.resolve({ width: 8, height: 8, close: () => {} }));
  vi.stubGlobal('createImageBitmap', decode);
  const image = file('image/png');

  await measureAttachment(image);
  await measureAttachment(image);

  expect(decode).toHaveBeenCalledTimes(1);
});

test('an undecodable image measures nothing rather than throwing', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.reject(new Error('not an image')))
  );

  await expect(measureAttachment(file('image/png'))).resolves.toEqual({
    info: null,
    thumbnail: null,
  });
});

test('a video reports dimensions and a duration in milliseconds', async () => {
  stubMediaElement({ videoWidth: 1920, videoHeight: 1080, duration: 12.34 });

  await expect(measureAttachment(file('video/mp4'))).resolves.toEqual({
    info: {
      width: 1920,
      height: 1080,
      duration_ms: 12_340,
      animated: null,
      blurhash: null,
      waveform: null,
      voice: false,
      audio_metadata: null,
      gif: null,
    },
    thumbnail: null,
  });
});

test('a video gets a JPEG thumbnail from its decoded frame', async () => {
  const video = stubMediaElement({ videoWidth: 1920, videoHeight: 1080, duration: 12 });
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }));
  });

  await expect(measureAttachment(file('video/mp4'))).resolves.toMatchObject({
    thumbnail: { bytes: new Uint8Array([255, 216, 255]), width: 800, height: 450 },
  });
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 800, 450);
  expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:stub');
});

test('a failed thumbnail keeps the video metadata', async () => {
  stubMediaElement({ videoWidth: 320, videoHeight: 240, duration: 2 });
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(null);
  });

  const { info, thumbnail } = await measureAttachment(file('video/mp4'));
  expect(info).toMatchObject({ width: 320, height: 240, duration_ms: 2000 });
  expect(thumbnail).toBeNull();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:stub');
});

test('a live stream reporting an infinite duration measures nothing', async () => {
  stubMediaElement({ videoWidth: 0, videoHeight: 0, duration: Number.POSITIVE_INFINITY });

  await expect(measureAttachment(file('video/mp4'))).resolves.toEqual({
    info: null,
    thumbnail: null,
  });
});

test('audio reports a duration and no dimensions', async () => {
  const audio = stubMediaElement({ duration: 5 });

  await expect(measureAttachment(file('audio/ogg'))).resolves.toEqual({
    info: {
      width: null,
      height: null,
      duration_ms: 5000,
      animated: null,
      blurhash: null,
      waveform: null,
      voice: false,
      audio_metadata: null,
      gif: null,
    },
    thumbnail: null,
  });
  expect(audio.preload).toBe('metadata');
  expect([...audio.listeners.keys()]).toEqual(['loadedmetadata', 'error']);
});

test('media the browser rejects measures nothing rather than throwing', async () => {
  stubMediaElement({ duration: 5, fail: true });

  await expect(measureAttachment(file('audio/ogg'))).resolves.toEqual({
    info: null,
    thumbnail: null,
  });
});

test('a file marked as a voice recording carries its waveform', async () => {
  const createElement = vi.spyOn(document, 'createElement');

  const recording = new File([new Uint8Array([1, 2, 3])], 'voice.webm', { type: 'audio/webm' });
  markVoiceRecording(recording, [0, 0.5, 1], 5000);

  await expect(measureAttachment(recording)).resolves.toEqual({
    info: {
      width: null,
      height: null,
      duration_ms: 5000,
      animated: null,
      blurhash: null,
      waveform: [0, 0.5, 1],
      voice: true,
      audio_metadata: null,
      gif: null,
    },
    thumbnail: null,
  });
  expect(createElement).not.toHaveBeenCalled();
});

test('a recording with an unreadable duration keeps its voice marker and waveform', async () => {
  stubMediaElement({ duration: Number.POSITIVE_INFINITY });
  const recording = new File([new Uint8Array([1, 2, 3])], 'voice.webm', { type: 'audio/webm' });
  markVoiceRecording(recording, [0, 0.5, 1], 5000);

  await expect(measureAttachment(recording)).resolves.toMatchObject({
    info: {
      voice: true,
      waveform: [0, 0.5, 1],
      duration_ms: 5000,
    },
  });
});

test('a document is not measured at all', async () => {
  const createElement = vi.spyOn(document, 'createElement');

  await expect(measureAttachment(file('application/pdf'))).resolves.toEqual({
    info: null,
    thumbnail: null,
  });
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
    cover_art_blurhash: null,
  });
  expect(
    await readAudioTags(new File([new Uint8Array(8)], 'x.mp3', { type: 'audio/mpeg' }))
  ).toBeNull();
});
