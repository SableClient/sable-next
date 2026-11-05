import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Track, type AudioProcessorOptions } from 'livekit-client';

const rnnoise = vi.hoisted(() => ({
  load: vi.fn<(options: { url: string; simdUrl: string }) => Promise<ArrayBuffer>>(),
  create: vi.fn(function (_context: AudioContext, _options: unknown) {
    return {
      connect: vi.fn((target: AudioNode) => target),
      disconnect: vi.fn(),
      destroy: vi.fn(),
    };
  }),
}));

vi.mock('@sapphi-red/web-noise-suppressor', () => ({
  loadRnnoise: rnnoise.load,
  RnnoiseWorkletNode: rnnoise.create,
}));

function contextFixture() {
  const output = { stop: vi.fn() };
  const source = { connect: vi.fn((target: AudioNode) => target), disconnect: vi.fn() };
  const destination = {
    disconnect: vi.fn(),
    stream: { getAudioTracks: () => [output], getTracks: () => [output] },
  };
  const context = {
    state: 'suspended' as AudioContextState,
    audioWorklet: { addModule: vi.fn(() => Promise.resolve()) },
    createMediaStreamSource: vi.fn(() => source),
    createMediaStreamDestination: vi.fn(() => destination),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  context.close.mockImplementation(() => {
    context.state = 'closed';
    return Promise.resolve();
  });
  return { context, output, source, destination };
}

let contexts: ReturnType<typeof contextFixture>[];
let AudioContextMock: ReturnType<typeof vi.fn>;
const wasmBinary = new ArrayBuffer(8);

beforeEach(() => {
  vi.resetModules();
  rnnoise.load.mockReset().mockResolvedValue(wasmBinary);
  rnnoise.create.mockClear();
  contexts = [];
  AudioContextMock = vi.fn(function () {
    const fixture = contextFixture();
    contexts.push(fixture);
    return fixture.context;
  });
  vi.stubGlobal('AudioContext', AudioContextMock);
  vi.stubGlobal('AudioWorkletNode', vi.fn());
  vi.stubGlobal('MediaStream', vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

test('requires browser audio and WASM support', async () => {
  const { supportsVoiceFilter } = await import('./voice-filter');
  expect(supportsVoiceFilter()).toBe(true);
  for (const name of ['AudioContext', 'AudioWorkletNode', 'WebAssembly'] as const) {
    const value = globalThis[name];
    vi.stubGlobal(name, undefined);
    expect(supportsVoiceFilter()).toBe(false);
    vi.stubGlobal(name, value);
  }
});

test('shares the WASM download and registers once per context with distinct mono filters', async () => {
  const { createVoiceFilterBank } = await import('./voice-filter');
  const first = createVoiceFilterBank();
  const second = createVoiceFilterBank();
  const nodes = await Promise.all([first.create(), first.create(), second.create()]);

  expect(AudioContextMock).toHaveBeenCalledWith({ sampleRate: 48000 });
  expect(rnnoise.load).toHaveBeenCalledOnce();
  const [assets] = rnnoise.load.mock.calls[0];
  expect(assets.url).toContain('rnnoise.wasm');
  expect(assets.simdUrl).toContain('rnnoise_simd.wasm');
  for (const { context } of contexts) expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
  expect(new Set(nodes).size).toBe(3);
  for (const node of nodes) {
    expect(node.channelCount).toBe(1);
    expect(node.channelCountMode).toBe('explicit');
  }
  expect(rnnoise.create).toHaveBeenCalledWith(contexts[0].context, {
    wasmBinary,
    maxChannels: 1,
  });
  first.close();
  second.close();
});

test('retries a failed asset download on the next bank', async () => {
  rnnoise.load.mockRejectedValueOnce(new Error('offline'));
  const { createVoiceFilterBank } = await import('./voice-filter');
  const first = createVoiceFilterBank();
  await expect(first.create()).rejects.toThrow('offline');
  first.close();
  const next = createVoiceFilterBank();
  await expect(next.create()).resolves.toBeDefined();
  expect(rnnoise.load).toHaveBeenCalledTimes(2);
  next.close();
});

function options(track: MediaStreamTrack): AudioProcessorOptions {
  return { kind: Track.Kind.Audio, track, audioContext: {} as AudioContext };
}

test('publishes filtered audio and releases its graph without stopping the microphone', async () => {
  const stop = vi.fn();
  const input = { stop } as unknown as MediaStreamTrack;
  const { createMicrophoneFilter } = await import('./voice-filter');
  const processor = createMicrophoneFilter();
  await processor.init(options(input));
  const { context, source, destination, output } = contexts[0];
  const filter = rnnoise.create.mock.results[0].value as ReturnType<typeof rnnoise.create>;

  expect(processor.processedTrack).toBe(output);
  expect(source.connect).toHaveBeenCalledWith(filter);
  expect(filter.connect).toHaveBeenCalledWith(destination);
  expect(context.resume).toHaveBeenCalledOnce();

  await processor.destroy();
  await processor.destroy();
  expect(processor.processedTrack).toBeUndefined();
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(filter.destroy).toHaveBeenCalledOnce();
  expect(filter.disconnect).toHaveBeenCalledOnce();
  expect(output.stop).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  expect(context.close).toHaveBeenCalledOnce();
});

test('rebuilds the microphone graph when the input track restarts', async () => {
  const { createMicrophoneFilter } = await import('./voice-filter');
  const processor = createMicrophoneFilter();
  await processor.init(options({} as MediaStreamTrack));
  const previous = contexts[0];
  const previousNode = rnnoise.create.mock.results[0].value as ReturnType<typeof rnnoise.create>;
  await processor.restart(options({} as MediaStreamTrack));

  expect(previousNode.destroy).toHaveBeenCalledOnce();
  expect(previous.output.stop).toHaveBeenCalledOnce();
  expect(previous.context.close).toHaveBeenCalledOnce();
  expect(processor.processedTrack).toBe(contexts[1].output);
  expect(rnnoise.load).toHaveBeenCalledOnce();
  await processor.destroy();
});

test('does not recreate a destroyed microphone graph after assets finish loading', async () => {
  const pending = Promise.withResolvers<ArrayBuffer>();
  rnnoise.load.mockReturnValue(pending.promise);
  const { createMicrophoneFilter } = await import('./voice-filter');
  const processor = createMicrophoneFilter();
  const initializing = processor.init(options({} as MediaStreamTrack));
  await processor.destroy();
  pending.resolve(new ArrayBuffer(8));

  await expect(initializing).rejects.toThrow('Voice filter bank is closed');
  expect(rnnoise.create).not.toHaveBeenCalled();
  expect(processor.processedTrack).toBeUndefined();
  expect(contexts[0].context.close).toHaveBeenCalledOnce();
});

test('cleans up a failed microphone initialization so the transport can fall back', async () => {
  const { createMicrophoneFilter } = await import('./voice-filter');
  const processor = createMicrophoneFilter();
  const initializing = processor.init(options({} as MediaStreamTrack));
  contexts[0].context.resume.mockRejectedValue(new Error('audio unavailable'));

  await expect(initializing).rejects.toThrow('audio unavailable');
  const filter = rnnoise.create.mock.results[0].value as ReturnType<typeof rnnoise.create>;
  expect(filter.destroy).toHaveBeenCalledOnce();
  expect(contexts[0].output.stop).toHaveBeenCalledOnce();
  expect(contexts[0].context.close).toHaveBeenCalledOnce();
  expect(processor.processedTrack).toBeUndefined();
});
