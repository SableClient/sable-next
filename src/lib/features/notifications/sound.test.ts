// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let playNotificationSound: typeof import('./sound').playNotificationSound;
let start: ReturnType<typeof vi.fn>;
let gains: { gain: { value: number } }[];

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
        connect: vi.fn((node: AudioNode) => node),
        start,
      }) as unknown as AudioBufferSourceNode
  );
  createGain = vi.fn<() => GainNode>(() => {
    const node = { gain: { value: 1 }, connect: vi.fn((next: AudioNode) => next) };
    gains.push(node);
    return node as unknown as GainNode;
  });
}

const nativeAudioContext = globalThis.AudioContext;
const nativeFetch = globalThis.fetch;

beforeEach(async () => {
  vi.resetModules();
  start = vi.fn();
  gains = [];
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

test('plays at the chosen volume', async () => {
  const { preferences } = await import('#lib/settings/preferences.svelte.js');
  preferences.notificationSoundVolume = 0.35;

  await playNotificationSound();

  expect(gains[0]?.gain.value).toBe(0.35);
});

test('plays the notification sound', async () => {
  await playNotificationSound();

  expect(fetch).toHaveBeenCalledWith('/sound/notification.ogg');
  expect(start).toHaveBeenCalledOnce();
});
