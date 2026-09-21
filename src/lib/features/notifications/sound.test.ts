// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let playNotificationSound: typeof import('./sound').playNotificationSound;
let start: ReturnType<typeof vi.fn>;

class MockAudioContext {
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;
  decodeAudioData = vi.fn<() => Promise<AudioBuffer>>().mockResolvedValue({} as AudioBuffer);
  resume = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  createBufferSource = vi.fn<() => AudioBufferSourceNode>(
    () =>
      ({
        addEventListener: vi.fn(),
        buffer: null,
        connect: vi.fn(),
        start,
      }) as unknown as AudioBufferSourceNode
  );
}

const nativeAudioContext = globalThis.AudioContext;
const nativeFetch = globalThis.fetch;

beforeEach(async () => {
  vi.resetModules();
  start = vi.fn();
  globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;
  globalThis.fetch = vi.fn<() => Promise<Response>>().mockResolvedValue({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as Response);
  ({ playNotificationSound } = await import('./sound'));
});

afterEach(() => {
  globalThis.AudioContext = nativeAudioContext;
  globalThis.fetch = nativeFetch;
});

test('plays the notification sound', async () => {
  await playNotificationSound();

  expect(fetch).toHaveBeenCalledWith('/sound/notification.ogg');
  expect(start).toHaveBeenCalledOnce();
});
