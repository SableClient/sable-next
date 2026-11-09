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
  preferences.soundsNotificationVolume = 0.35;

  await playNotificationSound('notification');

  expect(gains[0]?.gain.value).toBe(0.35);
});

test('plays the notification sound', async () => {
  await playNotificationSound('notification');

  expect(fetch).toHaveBeenCalledWith('/sound/msg.webm');
  expect(start).toHaveBeenCalledOnce();
});

test('decodes each sound once', async () => {
  const { playSound } = await import('./sound');
  await playSound('call_join');
  await playSound('call_join');

  expect(fetch).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
});

test('loads the sound again after a failed fetch', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));

  await expect(playNotificationSound('notification')).rejects.toThrow('offline');
  await playNotificationSound('notification');

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledOnce();
});

test('plays through the native notification stream on Android', async () => {
  const playNativeChime = vi.fn<(volume: number) => Promise<void>>().mockResolvedValue(undefined);
  vi.resetModules();
  vi.doMock('#lib/platform/os.js', () => ({ isAndroid: () => true }));
  vi.doMock('#lib/platform/native-notifications.js', () => ({ playNativeChime }));
  const { preferences } = await import('#lib/settings/preferences.svelte.js');
  preferences.soundsNotificationVolume = 0.5;
  ({ playNotificationSound } = await import('./sound'));

  await playNotificationSound('notification');

  expect(playNativeChime).toHaveBeenCalledWith(0.5);
  expect(fetch).not.toHaveBeenCalled();
  vi.doUnmock('#lib/platform/os.js');
  vi.doUnmock('#lib/platform/native-notifications.js');
});

test('stays silent while a native iOS call owns the audio session', async () => {
  vi.resetModules();
  vi.doMock('#lib/platform/calls.js', () => ({ nativeCallOwnsAudio: () => true }));
  const created = vi.fn();
  globalThis.AudioContext = class extends MockAudioContext {
    constructor() {
      super();
      created();
    }
  } as unknown as typeof AudioContext;
  const sound = await import('./sound');

  (await sound.playSound('mic_on')).stop();
  await sound.playNotificationSound('notification');

  expect(created).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  vi.doUnmock('#lib/platform/calls.js');
});

test('releasing the audio closes the shared context', async () => {
  const contexts: MockAudioContext[] = [];
  globalThis.AudioContext = class extends MockAudioContext {
    constructor() {
      super();
      contexts.push(this);
    }
  } as unknown as typeof AudioContext;
  const { playSound, releaseNotificationAudio } = await import('./sound');
  await playSound('call_join');

  releaseNotificationAudio();

  expect(contexts).toHaveLength(1);
  expect(contexts[0]?.close).toHaveBeenCalledOnce();
});
