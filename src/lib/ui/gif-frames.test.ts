import { afterEach, expect, test, vi } from 'vitest';

import { openGifPlayback } from './gif-frames';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubDecoder(track: unknown, duration: number | null = 300_000): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
  );
  vi.stubGlobal(
    'ImageDecoder',
    class {
      tracks = { ready: Promise.resolve(), selectedTrack: track };
      completed = Promise.resolve();
      decode() {
        return Promise.resolve({
          image: { displayWidth: 4, displayHeight: 4, duration, close: () => {} },
        });
      }
      close() {}
    }
  );
}

test('gives up where the platform cannot decode frames', async () => {
  vi.stubGlobal('ImageDecoder', undefined);

  expect(await openGifPlayback('blob:gif')).toBeNull();
});

test('gives up on an image that is not worth stepping', async () => {
  stubDecoder({ animated: false, frameCount: 1 });

  expect(await openGifPlayback('blob:still')).toBeNull();
});

test('reports frame delays in milliseconds', async () => {
  stubDecoder({ animated: true, frameCount: 3 });
  const playback = await openGifPlayback('blob:gif');

  expect(playback?.frameCount).toBe(3);
  expect((await playback?.frame(1))?.durationMs).toBe(300);
});

test('floors a frame carrying no delay of its own', async () => {
  stubDecoder({ animated: true, frameCount: 3 }, null);
  const playback = await openGifPlayback('blob:gif');

  expect((await playback?.frame(0))?.durationMs).toBe(100);
});

test('gives up when the bytes cannot be fetched', async () => {
  stubDecoder({ animated: true, frameCount: 3 });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('gone')))
  );

  expect(await openGifPlayback('blob:gone')).toBeNull();
});

function stubFrames(decode: (request: { frameIndex: number }) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
  );
  vi.stubGlobal(
    'ImageDecoder',
    class {
      tracks = { ready: Promise.resolve(), selectedTrack: { animated: true, frameCount: 3 } };
      completed = Promise.resolve();
      decode(request: { frameIndex: number }) {
        return Promise.resolve({ image: decode(request) });
      }
      close() {}
    }
  );
}

test('leaves a decoder its own cached frame, which closing would empty', async () => {
  const frames = new Map<number, { displayWidth: number }>();
  stubFrames(({ frameIndex }) => {
    let image = frames.get(frameIndex);
    if (image === undefined) {
      const frame = {
        displayWidth: 4,
        displayHeight: 4,
        duration: 300_000,
        close: (): void => {
          frame.displayWidth = 0;
        },
      };
      image = frame;
      frames.set(frameIndex, frame);
    }
    return image;
  });
  const playback = await openGifPlayback('blob:gif');

  (await playback?.frame(1))?.release();

  expect((await playback?.frame(1))?.image.displayWidth).toBe(4);
});

test('closes a frame the decoder hands over', async () => {
  const closed = vi.fn();
  stubFrames(() => ({ displayWidth: 4, displayHeight: 4, duration: 300_000, close: closed }));
  const playback = await openGifPlayback('blob:gif');
  closed.mockClear();

  (await playback?.frame(1))?.release();

  expect(closed).toHaveBeenCalledOnce();
});
