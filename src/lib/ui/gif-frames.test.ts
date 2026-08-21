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
