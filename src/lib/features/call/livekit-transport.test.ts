import { afterEach, expect, test, vi } from 'vitest';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';

import { createLivekitTransport } from './livekit-transport';
import { ScreenAudioError } from './call-transport';
import type { CallTelemetry } from './call-telemetry';
import { MatrixKeyProvider } from './key-provider';
import { preferences } from '#lib/settings/preferences.svelte.js';

const screenAudio = vi.hoisted(() => ({
  screenAudioSupported: vi.fn(() => false),
  captureScreenAudio: vi.fn<() => Promise<MediaStreamTrack>>(),
  stopScreenAudio: vi.fn(() => Promise.resolve()),
}));
vi.mock('#lib/platform/screen-audio.js', () => screenAudio);

const hdr = vi.hoisted(() => ({
  startHdrShare: vi.fn<(monitor: number, onEnded: () => void) => Promise<MediaStreamTrack>>(),
  stopHdrShare: vi.fn(() => Promise.resolve()),
}));
vi.mock('#lib/platform/hdr-share.js', () => hdr);

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
  const screen = vi.fn<Room['localParticipant']['setScreenShareEnabled']>((enabled: boolean) => {
    screenEnabled = enabled;
    return Promise.resolve(undefined);
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
  vi.unstubAllGlobals();
  preferences.callCameraResolution = 'auto';
  preferences.callCameraBitrate = 'auto';
  preferences.callCameraCodec = 'auto';
  preferences.callScreenResolution = 'auto';
  preferences.callScreenBitrate = 'auto';
  preferences.callScreenCodec = 'auto';
  preferences.callSimulcast = true;
});

test('automatic video quality leaves capture and encoding choices to LiveKit', async () => {
  const fixture = roomFixture();
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });
  await transport.connect({ ...connectOptions, cameraEnabled: true });
  expect(fixture.camera).toHaveBeenCalledWith(true, {}, {});
  await transport.capabilities.screenShare?.setEnabled(true);
  const [, capture, publish] = fixture.localParticipant.setScreenShareEnabled.mock.calls[0];
  expect(capture).not.toHaveProperty('resolution');
  expect(publish).not.toHaveProperty('screenShareEncoding');
  expect(publish).not.toHaveProperty('videoCodec');
  await transport.disconnect();
});

test('turning simulcast off applies to camera and screen publishing', async () => {
  preferences.callSimulcast = false;
  const fixture = roomFixture();
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });
  try {
    await transport.connect({ ...connectOptions, cameraEnabled: true });
    expect(fixture.camera).toHaveBeenCalledWith(true, {}, { simulcast: false });
    await transport.capabilities.screenShare?.setEnabled(true);
    expect(fixture.localParticipant.setScreenShareEnabled.mock.calls[0][2]).toMatchObject({
      simulcast: false,
    });
  } finally {
    await transport.disconnect();
  }
});

test('camera quality applies on join and when enabling the camera later', async () => {
  preferences.callCameraResolution = '360';
  preferences.callCameraBitrate = '250';
  preferences.callCameraCodec = 'h264';
  preferences.videoInputDevice = 'camera-1';
  const fixture = roomFixture();
  const createRoom = vi.fn(() => fixture.room);
  const transport = createLivekitTransport({ encryptMedia: false, createRoom });
  try {
    await transport.connect({ ...connectOptions, cameraEnabled: true });
    const capture = { deviceId: 'camera-1', resolution: { width: 640, height: 360 } };
    const publish = {
      videoEncoding: { maxBitrate: 250_000 },
      videoCodec: 'h264',
      backupCodec: { codec: 'vp8', encoding: { maxBitrate: 250_000 } },
    };
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ videoCaptureDefaults: capture })
    );
    expect(fixture.camera).toHaveBeenLastCalledWith(true, capture, publish);
    preferences.callCameraBitrate = '8000';
    await transport.setCameraEnabled(false);
    await transport.setCameraEnabled(true);
    expect(fixture.camera).toHaveBeenLastCalledWith(true, capture, publish);
  } finally {
    preferences.videoInputDevice = '';
    await transport.disconnect();
  }
});

test.each([false, true])(
  'screen quality applies with native audio capture %s',
  async (nativeAudio) => {
    preferences.callScreenResolution = '720';
    preferences.callScreenBitrate = '1000';
    preferences.callScreenCodec = 'vp9';
    preferences.callCameraBitrate = '250';
    screenAudio.screenAudioSupported.mockReturnValue(nativeAudio);
    const fixture = roomFixture();
    const transport = createLivekitTransport({
      encryptMedia: false,
      createRoom: () => fixture.room,
    });
    try {
      await transport.connect(connectOptions);
      await transport.capabilities.screenShare?.setEnabled(true);
      expect(fixture.localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(
        true,
        expect.objectContaining({ resolution: { width: 1280, height: 720 } }),
        expect.objectContaining({
          screenShareEncoding: { maxBitrate: 1_000_000 },
          videoCodec: 'vp9',
          backupCodec: { codec: 'vp8', encoding: { maxBitrate: 1_000_000 } },
        })
      );
    } finally {
      await transport.disconnect();
      screenAudio.screenAudioSupported.mockReturnValue(false);
    }
  }
);

test('HDR sharing uses the screen resolution and publish quality', async () => {
  preferences.callScreenResolution = '480';
  preferences.callScreenBitrate = '500';
  preferences.callScreenCodec = 'av1';
  const fixture = roomFixture();
  const publisher = withPublishing(fixture);
  hdr.startHdrShare.mockResolvedValue(Object.assign(audioTrackStub(), { kind: 'video' }));
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });
  await transport.connect(connectOptions);
  await transport.capabilities.screenShare?.setEnabled(true, undefined, {
    kind: 'hdr',
    monitor: 2,
  });
  expect(hdr.startHdrShare).toHaveBeenLastCalledWith(2, expect.any(Function), {
    width: 853,
    height: 480,
  });
  expect(publisher.publishTrack).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      source: 'screen_share',
      screenShareEncoding: { maxBitrate: 500_000 },
      videoCodec: 'av1',
    })
  );
  await transport.disconnect();
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
  void provider.setKey({ identity: 'publisher', keyIndex: 0, key: new Uint8Array(16) }, true);
  await vi.waitFor(() => {
    expect(provider.state.lastFailure).toBe('import-failed');
  });
  await expect(provider.waitForOwnKey('publisher')).rejects.toThrow('own-key-failed');
  expect(vi.getTimerCount()).toBe(0);
});

test('imports every initial encryption key before connecting', async () => {
  const fixture = roomFixture();
  const material = await crypto.subtle.importKey('raw', new Uint8Array(16), 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);
  const remoteImport = Promise.withResolvers<CryptoKey>();
  const importKey = vi.spyOn(crypto.subtle, 'importKey');
  importKey.mockImplementationOnce(() => Promise.resolve(material));
  importKey.mockImplementationOnce(() => remoteImport.promise);
  const transport = createLivekitTransport({
    encryptMedia: true,
    ownIdentity: 'publisher',
    createRoom: () => fixture.room,
    createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
  });

  const connecting = transport.connect({
    ...connectOptions,
    encryptionKeys: [
      { identity: 'publisher', keyIndex: 0, key: new Uint8Array(16) },
      { identity: 'remote', keyIndex: 0, key: new Uint8Array(16) },
    ],
  });
  await vi.waitFor(() => {
    expect(importKey).toHaveBeenCalledTimes(2);
  });
  expect(fixture.room.connect).not.toHaveBeenCalled();

  remoteImport.resolve(material);
  await connecting;
  expect(fixture.room.connect).toHaveBeenCalledOnce();
  await transport.disconnect();
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

function audioTrackStub(): MediaStreamTrack & { stop: ReturnType<typeof vi.fn> } {
  return {
    kind: 'audio',
    id: 'screen-audio',
    enabled: true,
    muted: false,
    readyState: 'live',
    getSettings: () => ({ deviceId: 'screen-audio' }),
    getConstraints: () => ({}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

function withPublishing(fixture: ReturnType<typeof roomFixture>) {
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(private readonly tracks: MediaStreamTrack[] = []) {}
      getTracks() {
        return this.tracks;
      }
      getAudioTracks() {
        return this.tracks;
      }
    }
  );
  return Object.assign(fixture.localParticipant, {
    publishTrack: vi.fn(() => Promise.resolve()),
    unpublishTrack: vi.fn(() => Promise.resolve()),
  });
}

test('a share without our own audio capture asks the browser for stereo system audio', async () => {
  const fixture = roomFixture();
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  await transport.connect(connectOptions);
  await transport.capabilities.screenShare?.setEnabled(true);

  expect(fixture.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      systemAudio: 'include',
      audio: expect.objectContaining({
        channelCount: 2,
        echoCancellation: false,
        restrictOwnAudio: true,
      }) as unknown,
    }),
    expect.objectContaining({ forceStereo: true, dtx: false, red: false })
  );

  await transport.capabilities.screenShare?.setEnabled(false);
  expect(fixture.localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(false);
});

test('an HDR monitor is published as the screen share and stopped with it', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  const screen = Object.assign(audioTrackStub(), {
    kind: 'video',
    id: 'hdr-screen',
    getSettings: () => ({ width: 1920, height: 1080 }),
  });
  hdr.startHdrShare.mockResolvedValue(screen);
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  await transport.connect(connectOptions);
  await transport.capabilities.screenShare?.setEnabled(true, undefined, {
    kind: 'hdr',
    monitor: 1,
  });

  expect(hdr.startHdrShare).toHaveBeenCalledWith(1, expect.any(Function), undefined);
  expect(participant.publishTrack).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ source: 'screen_share' })
  );
  expect(fixture.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled();

  await transport.capabilities.screenShare?.setEnabled(false);

  expect(participant.unpublishTrack).toHaveBeenCalledOnce();
  expect(hdr.stopHdrShare).toHaveBeenCalledOnce();
  expect(fixture.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled();
});

test('an HDR share the desktop ends is unpublished', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  const screen = Object.assign(audioTrackStub(), {
    kind: 'video',
    id: 'hdr-screen',
    getSettings: () => ({ width: 1920, height: 1080 }),
  });
  let ended = (): void => undefined;
  hdr.startHdrShare.mockImplementationOnce((_, onEnded) => {
    ended = onEnded;
    return Promise.resolve(screen);
  });
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  await transport.connect(connectOptions);
  await transport.capabilities.screenShare?.setEnabled(true, undefined, {
    kind: 'hdr',
    monitor: 0,
  });
  ended();

  await vi.waitFor(() => {
    expect(hdr.stopHdrShare).toHaveBeenCalled();
  });
  expect(participant.unpublishTrack).toHaveBeenCalledOnce();
});

test('publishes the screen audio beside the share, and tears it down with it', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  screenAudio.screenAudioSupported.mockReturnValue(true);
  screenAudio.captureScreenAudio.mockResolvedValue(audioTrackStub());
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  await transport.connect(connectOptions);
  await transport.capabilities.screenShare?.setEnabled(true, { kind: 'apps', include: ['mpv'] });

  expect(screenAudio.captureScreenAudio).toHaveBeenCalledWith({ kind: 'apps', include: ['mpv'] });
  expect(participant.publishTrack).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ source: 'screen_share_audio', forceStereo: true })
  );

  await transport.capabilities.screenShare?.setEnabled(false);

  expect(participant.unpublishTrack).toHaveBeenCalledOnce();
  expect(screenAudio.stopScreenAudio).toHaveBeenCalledOnce();
  screenAudio.screenAudioSupported.mockReturnValue(false);
});

test('keeps sharing the screen when its audio cannot be captured', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  screenAudio.screenAudioSupported.mockReturnValue(true);
  screenAudio.captureScreenAudio.mockRejectedValue(new Error('no pipewire'));
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  await transport.connect(connectOptions);
  await expect(
    transport.capabilities.screenShare?.setEnabled(true, { kind: 'system', exclude: [] })
  ).rejects.toBeInstanceOf(ScreenAudioError);

  expect(fixture.localParticipant.isScreenShareEnabled).toBe(true);
  expect(participant.publishTrack).not.toHaveBeenCalled();
  screenAudio.screenAudioSupported.mockReturnValue(false);
});

test.each(['stop', 'disconnect', 'desktop'])(
  'releases screen audio acquired after %s',
  async (ending) => {
    const fixture = roomFixture();
    const participant = withPublishing(fixture);
    const capture = Promise.withResolvers<MediaStreamTrack>();
    const track = audioTrackStub();
    screenAudio.screenAudioSupported.mockReturnValue(true);
    screenAudio.captureScreenAudio.mockReturnValueOnce(capture.promise);
    const transport = createLivekitTransport({
      encryptMedia: false,
      createRoom: () => fixture.room,
    });

    try {
      await transport.connect(connectOptions);
      const sharing = transport.capabilities.screenShare?.setEnabled(true, {
        kind: 'system',
        exclude: [],
      });
      await vi.waitFor(() => {
        expect(screenAudio.captureScreenAudio).toHaveBeenCalled();
      });

      if (ending === 'disconnect') await transport.disconnect();
      else if (ending === 'stop') await transport.capabilities.screenShare?.setEnabled(false);
      else {
        await fixture.localParticipant.setScreenShareEnabled(false);
        fixture.room.emit(RoomEvent.LocalTrackUnpublished, { source: 'screen_share' });
      }
      capture.resolve(track);
      await sharing;

      expect(participant.publishTrack).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalled();
      expect(screenAudio.stopScreenAudio).toHaveBeenCalled();
    } finally {
      screenAudio.screenAudioSupported.mockReturnValue(false);
    }
  }
);

test('releases screen audio when publishing fails', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  const track = audioTrackStub();
  participant.publishTrack.mockRejectedValueOnce(new Error('publication failed'));
  screenAudio.screenAudioSupported.mockReturnValue(true);
  screenAudio.captureScreenAudio.mockResolvedValueOnce(track);
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  try {
    await transport.connect(connectOptions);
    await expect(
      transport.capabilities.screenShare?.setEnabled(true, { kind: 'system', exclude: [] })
    ).rejects.toBeInstanceOf(ScreenAudioError);

    expect(track.stop).toHaveBeenCalled();
    expect(screenAudio.stopScreenAudio).toHaveBeenCalled();
  } finally {
    screenAudio.screenAudioSupported.mockReturnValue(false);
  }
});

test('finishes capture cleanup before restarting screen audio', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  const firstCapture = Promise.withResolvers<MediaStreamTrack>();
  const stopped = Promise.withResolvers<undefined>();
  const firstTrack = audioTrackStub();
  const nextTrack = audioTrackStub();
  screenAudio.screenAudioSupported.mockReturnValue(true);
  screenAudio.captureScreenAudio.mockClear();
  screenAudio.captureScreenAudio
    .mockReturnValueOnce(firstCapture.promise)
    .mockResolvedValueOnce(nextTrack);
  screenAudio.stopScreenAudio.mockReturnValueOnce(stopped.promise);
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });
  const choice = { kind: 'system' as const, exclude: [] };

  try {
    await transport.connect(connectOptions);
    const first = transport.capabilities.screenShare?.setEnabled(true, choice);
    await vi.waitFor(() => {
      expect(screenAudio.captureScreenAudio).toHaveBeenCalledOnce();
    });
    await transport.capabilities.screenShare?.setEnabled(false);
    const next = transport.capabilities.screenShare?.setEnabled(true, choice);
    firstCapture.resolve(firstTrack);
    await vi.waitFor(() => {
      expect(firstTrack.stop).toHaveBeenCalled();
    });
    expect(screenAudio.captureScreenAudio).toHaveBeenCalledOnce();
    stopped.resolve(undefined);
    await Promise.all([first, next]);

    expect(screenAudio.captureScreenAudio).toHaveBeenCalledTimes(2);
    expect(participant.publishTrack).toHaveBeenCalledOnce();
    expect(nextTrack.stop).not.toHaveBeenCalled();
    await transport.disconnect();
    expect(nextTrack.stop).toHaveBeenCalled();
  } finally {
    stopped.resolve(undefined);
    screenAudio.screenAudioSupported.mockReturnValue(false);
  }
});

test('restarts screen audio after a cancelled capture fails', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  const firstCapture = Promise.withResolvers<MediaStreamTrack>();
  screenAudio.screenAudioSupported.mockReturnValue(true);
  screenAudio.captureScreenAudio.mockClear();
  screenAudio.captureScreenAudio
    .mockReturnValueOnce(firstCapture.promise)
    .mockResolvedValueOnce(audioTrackStub());
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });
  const choice = { kind: 'system' as const, exclude: [] };

  try {
    await transport.connect(connectOptions);
    const first = transport.capabilities.screenShare?.setEnabled(true, choice);
    await vi.waitFor(() => {
      expect(screenAudio.captureScreenAudio).toHaveBeenCalledOnce();
    });
    await transport.capabilities.screenShare?.setEnabled(false);
    const next = transport.capabilities.screenShare?.setEnabled(true, choice);
    firstCapture.reject(new Error('capture ended'));
    await Promise.all([first, next]);

    expect(screenAudio.captureScreenAudio).toHaveBeenCalledTimes(2);
    expect(participant.publishTrack).toHaveBeenCalledOnce();
    await transport.disconnect();
  } finally {
    screenAudio.screenAudioSupported.mockReturnValue(false);
  }
});

test('shares no audio when the reader chose none', async () => {
  const fixture = roomFixture();
  const participant = withPublishing(fixture);
  screenAudio.screenAudioSupported.mockReturnValue(true);
  screenAudio.captureScreenAudio.mockClear();
  const transport = createLivekitTransport({ encryptMedia: false, createRoom: () => fixture.room });

  await transport.connect(connectOptions);
  await transport.capabilities.screenShare?.setEnabled(true, { kind: 'none' });

  expect(screenAudio.captureScreenAudio).not.toHaveBeenCalled();
  expect(participant.publishTrack).not.toHaveBeenCalled();
  screenAudio.screenAudioSupported.mockReturnValue(false);
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
