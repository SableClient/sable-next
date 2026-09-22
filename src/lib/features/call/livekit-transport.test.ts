import { afterEach, expect, test, vi } from 'vitest';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';

import { createLivekitTransport } from './livekit-transport';
import type { CallTelemetry } from './call-telemetry';
import { MatrixKeyProvider } from './key-provider';
import { preferences } from '#lib/settings/preferences.svelte.js';

function roomFixture() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let state = ConnectionState.Disconnected;
  let micEnabled = false;
  let cameraEnabled = false;
  let screenEnabled = false;
  const mic = vi.fn((enabled: boolean) => {
    micEnabled = enabled;
    return Promise.resolve();
  });
  const camera = vi.fn((enabled: boolean) => {
    cameraEnabled = enabled;
    return Promise.resolve();
  });
  const screen = vi.fn((enabled: boolean) => {
    screenEnabled = enabled;
    return Promise.resolve();
  });
  const localParticipant = {
    getTrackPublication: vi.fn(() => undefined),
    get isMicrophoneEnabled() {
      return micEnabled;
    },
    get isCameraEnabled() {
      return cameraEnabled;
    },
    get isScreenShareEnabled() {
      return screenEnabled;
    },
    setMicrophoneEnabled: mic,
    setCameraEnabled: camera,
    setScreenShareEnabled: screen,
  };
  const room = {
    remoteParticipants: new Map(),
    localParticipant,
    get state() {
      return state;
    },
    canPlaybackAudio: true,
    on(event: RoomEvent, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return room;
    },
    off(event: RoomEvent, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      return room;
    },
    connect: vi.fn(() => {
      state = ConnectionState.Connected;
      return Promise.resolve();
    }),
    setE2EEEnabled: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => {
      state = ConnectionState.Disconnected;
      return Promise.resolve();
    }),
    emit(event: RoomEvent, ...args: unknown[]) {
      listeners.get(event)?.forEach((listener) => {
        listener(...args);
      });
    },
    setState(next: ConnectionState) {
      state = next;
    },
  } as unknown as Room & {
    emit: (event: RoomEvent, ...args: unknown[]) => void;
    setState: (state: ConnectionState) => void;
  };
  return { room, mic, camera, localParticipant };
}

const connectOptions = {
  url: 'wss://example.test',
  token: 'token',
  microphoneEnabled: true,
  cameraEnabled: false,
  encryptionKeys: [],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('imports the publisher key before connecting or capturing audio', async () => {
  const fixture = roomFixture();
  const material = await crypto.subtle.importKey('raw', new Uint8Array(16), 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);
  const imported = Promise.withResolvers<CryptoKey>();
  vi.spyOn(crypto.subtle, 'importKey').mockReturnValue(imported.promise);
  const transport = createLivekitTransport({
    encryptMedia: true,
    ownIdentity: 'publisher',
    createRoom: () => fixture.room,
    createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
  });
  const connecting = transport.connect({
    ...connectOptions,
    encryptionKeys: [{ identity: 'publisher', keyIndex: 0, key: new Uint8Array(16) }],
  });
  await Promise.resolve();
  expect(fixture.room.connect).not.toHaveBeenCalled();
  expect(fixture.mic).not.toHaveBeenCalled();
  imported.resolve(material);
  await connecting;
  expect(fixture.room.connect).toHaveBeenCalledOnce();
  expect(fixture.mic).toHaveBeenCalledOnce();
  await transport.disconnect();
});

test('cancels a pending publisher key wait without connecting', async () => {
  vi.useFakeTimers();
  const fixture = roomFixture();
  const transport = createLivekitTransport({
    encryptMedia: true,
    ownIdentity: 'publisher',
    createRoom: () => fixture.room,
    createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
  });
  const connecting = expect(transport.connect(connectOptions)).rejects.toThrow('call-cancelled');
  await transport.disconnect();
  await connecting;
  expect(fixture.room.connect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('does not enable the camera after cancellation during microphone setup', async () => {
  const fixture = roomFixture();
  const microphone = Promise.withResolvers<undefined>();
  fixture.mic.mockReturnValue(microphone.promise);
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });
  const connecting = expect(
    transport.connect({ ...connectOptions, cameraEnabled: true })
  ).rejects.toThrow('call-cancelled');
  await vi.waitFor(() => {
    expect(fixture.mic).toHaveBeenCalledOnce();
  });
  await transport.disconnect();
  microphone.resolve(undefined);
  await connecting;
  expect(fixture.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  expect(transport.getState().connection).toBe('disconnected');
});

test('a subscriber never requests microphone, camera, or screen sharing', async () => {
  const fixture = roomFixture();
  const transport = createLivekitTransport({
    encryptMedia: false,
    publishMedia: false,
    createRoom: () => fixture.room,
  });
  await transport.connect({ ...connectOptions, cameraEnabled: true });
  await transport.setMicrophoneEnabled(true);
  await transport.setCameraEnabled(true);
  await transport.capabilities.screenShare?.setEnabled(true);
  expect(fixture.mic).not.toHaveBeenCalled();
  expect(fixture.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  expect(fixture.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled();
  await transport.disconnect();
});

test('an existing key import failure rejects immediately without leaving a timer', async () => {
  vi.useFakeTimers();
  vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error('import failed'));
  const provider = new MatrixKeyProvider();
  provider.setKey({ identity: 'publisher', keyIndex: 0, key: new Uint8Array(16) }, true);
  await vi.waitFor(() => {
    expect(provider.state.lastFailure).toBe('import-failed');
  });
  await expect(provider.waitForOwnKey('publisher')).rejects.toThrow('own-key-failed');
  expect(vi.getTimerCount()).toBe(0);
});

test('does not publish connected when the room disconnects during media setup', async () => {
  const fixture = roomFixture();
  let releaseMic!: () => void;
  fixture.mic.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseMic = resolve;
        fixture.room.setState(ConnectionState.Disconnected);
      })
  );
  const transport = createLivekitTransport({
    encryptMedia: false,
    createRoom: () => fixture.room,
  });

  const connecting = transport.connect(connectOptions);
  await vi.waitFor(() => {
    expect(fixture.mic).toHaveBeenCalledOnce();
  });
  releaseMic();
  await expect(connecting).rejects.toThrow('transport-not-connected');
  expect(transport.getState().connection).toBe('disconnected');
});

test('runs without telemetry and performs media toggles once', async () => {
  const fixture = roomFixture();
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  await transport.connect(connectOptions);
  await transport.setMicrophoneEnabled(false);
  await transport.setCameraEnabled(true);
  await transport.capabilities.screenShare?.setEnabled(true);

  expect(fixture.mic).toHaveBeenCalledTimes(2);
  expect(fixture.localParticipant.setCameraEnabled).toHaveBeenCalledTimes(2);
  expect(fixture.localParticipant.setScreenShareEnabled).toHaveBeenCalledOnce();
});

test('stops health snapshots and suppresses an in-flight result after disconnect', async () => {
  vi.useFakeTimers();
  let resolveStats!: () => void;
  const fixture = roomFixture();
  const senderStats = new Promise<{ bytesSent: number }>((resolve) => {
    resolveStats = () => {
      resolve({ bytesSent: 42 });
    };
  });
  fixture.localParticipant.getTrackPublication.mockReturnValue({
    track: { getSenderStats: () => senderStats },
  } as never);
  const event = vi.fn();
  const telemetry: Pick<CallTelemetry, 'event' | 'failure' | 'step'> = {
    event,
    failure: vi.fn(),
    step: <T>(_stage: string, action: () => Promise<T>): Promise<T> => action(),
  };
  const transport = createLivekitTransport({
    encryptMedia: false,
    createRoom: () => fixture.room,
    telemetry,
  });

  await transport.connect(connectOptions);
  await vi.advanceTimersByTimeAsync(10_000);
  await transport.disconnect();
  resolveStats();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(30_000);

  expect(event.mock.calls.filter(([stage]) => stage === 'call.media.health')).toHaveLength(0);
});

test('emits per-receiver health without the participant identity', async () => {
  vi.useFakeTimers();
  const fixture = roomFixture();
  fixture.room.remoteParticipants.set('remote', {
    identity: 'sensitive-participant-identity',
    connectionQuality: 0,
    getTrackPublication: vi.fn(() => ({
      isSubscribed: true,
      isMuted: false,
      track: {
        getReceiverStats: () =>
          Promise.resolve({
            bytesReceived: 12,
            totalAudioEnergy: 3,
            totalSamplesDuration: 4,
          }),
      },
    })),
  } as never);
  const event = vi.fn();
  const telemetry: Pick<CallTelemetry, 'event' | 'failure' | 'step'> = {
    event,
    failure: vi.fn(),
    step: <T>(_stage: string, action: () => Promise<T>): Promise<T> => action(),
  };
  const transport = createLivekitTransport({
    encryptMedia: false,
    createRoom: () => fixture.room,
    telemetry,
  });

  await transport.connect(connectOptions);
  await vi.advanceTimersByTimeAsync(10_000);

  const receiver = event.mock.calls.find(([stage]) => stage === 'call.media.receiver_health');
  expect(receiver).toEqual([
    'call.media.receiver_health',
    expect.objectContaining({
      'call.participant_index': 0,
      'audio.key_present': false,
      'audio.published': true,
      'audio.subscribed': true,
      'audio.muted': false,
      'audio.receiver_stats_available': true,
      'audio.receiver_bytes': 12,
      'audio.receiver_total_audio_energy': 3,
      'audio.receiver_total_samples_duration': 4,
    }),
  ]);
  expect(JSON.stringify(receiver)).not.toContain('sensitive-participant-identity');
  await transport.disconnect();
});

test('carries the microphone processing preferences into the room options', () => {
  preferences.noiseSuppression = false;
  preferences.echoCancellation = false;
  preferences.autoGainControl = true;

  let options: ConstructorParameters<typeof Room>[0];
  createLivekitTransport({
    encryptMedia: false,
    createRoom: (config) => {
      options = config;
      return roomFixture().room;
    },
  });

  expect(options?.audioCaptureDefaults).toEqual({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  });

  preferences.noiseSuppression = true;
  preferences.echoCancellation = true;
});

test('connects audio-only when the camera permission was refused', async () => {
  const fixture = roomFixture();
  const denied = new Error('NotAllowedError');
  fixture.camera.mockRejectedValue(denied);
  const failure = vi.fn();
  const transport = createLivekitTransport({
    encryptMedia: false,
    createRoom: () => fixture.room,
    telemetry: { step: (_stage, action) => action(), event: vi.fn(), failure },
  });

  await transport.connect({ ...connectOptions, cameraEnabled: true });

  expect(transport.getState().connection).toBe('connected');
  expect(transport.getState().error).toBeUndefined();
  expect(fixture.mic).toHaveBeenCalledWith(true);
  expect(failure).toHaveBeenCalledWith('call.camera.set', denied, expect.anything());
  await transport.disconnect();
});

test('connects listen-only when the microphone permission was refused', async () => {
  const fixture = roomFixture();
  fixture.mic.mockRejectedValue(new Error('NotAllowedError'));
  const transport = createLivekitTransport({
    encryptMedia: false,
    createRoom: () => fixture.room,
  });

  await transport.connect(connectOptions);

  expect(transport.getState().connection).toBe('connected');
  expect(fixture.camera).toHaveBeenCalledOnce();
  await transport.disconnect();
});

test('publishes the local participant so the call can render a self view', async () => {
  const fixture = roomFixture();
  const transport = createLivekitTransport({
    encryptMedia: false,
    createRoom: () => fixture.room,
  });

  await transport.connect({ ...connectOptions, cameraEnabled: true });

  expect(transport.getState().self).toMatchObject({ local: true });
  expect(transport.getState().participants).toHaveLength(0);
  await transport.disconnect();
});
