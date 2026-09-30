import { afterEach, expect, test, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  options: {} as Record<string, unknown>,
  encoder: null as {
    onstart: () => void;
    onstop: () => void;
    ondataavailable: (bytes: Uint8Array) => void;
  } | null,
}));

vi.mock('opus-recorder', () => ({
  default: class {
    onstart = () => {};
    onstop = () => {};
    ondataavailable = (_bytes: Uint8Array) => {};
    constructor(options: Record<string, unknown>) {
      fake.options = options;
      fake.encoder = this;
    }
    start = fake.start;
    close = fake.close;
    stop() {
      this.ondataavailable(new Uint8Array([1, 2, 3]));
      this.onstop();
      return Promise.resolve();
    }
  },
}));

import { createOggRecorder } from './voice-recorder-encoder';

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function session() {
  const source = {};
  const context = {
    createMediaStreamSource: () => source,
  } as unknown as AudioContext;
  return { ...createOggRecorder({} as MediaStream, context), source };
}

test('adapts encoder output without a native BlobEvent and disposes the encoder', async () => {
  vi.stubGlobal('BlobEvent', undefined);
  fake.start.mockResolvedValue(undefined);
  fake.close.mockResolvedValue(undefined);
  const { recorder, dispose, source } = session();
  const onStart = vi.fn();
  const onStop = vi.fn();
  const onData = vi.fn<(event: BlobEvent) => void>();
  recorder.onstart = onStart;
  recorder.onstop = onStop;
  recorder.ondataavailable = onData;

  expect(fake.options).toMatchObject({ sourceNode: source, encoderSampleRate: 48_000 });
  recorder.start();
  fake.encoder?.onstart();
  expect(recorder.state).toBe('recording');
  expect(onStart).toHaveBeenCalledOnce();
  recorder.stop();

  expect(recorder.state).toBe('inactive');
  expect(onStop).toHaveBeenCalledOnce();
  const [event] = onData.mock.calls[0];
  expect(event.data.type).toBe('audio/ogg');
  expect(new Uint8Array(await event.data.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  dispose();
  expect(fake.close).toHaveBeenCalledOnce();
});

test('reports encoder startup failures through the recorder error handler', async () => {
  fake.start.mockRejectedValue(new Error('encoder unavailable'));
  const { recorder } = session();
  const onError = vi.fn();
  recorder.onerror = onError;
  recorder.start();
  await vi.waitFor(() => {
    expect(onError).toHaveBeenCalledOnce();
  });
  expect(recorder.state).toBe('inactive');
});
