import type { NativeCallSnapshot } from '@sableclient/tauri-plugin-livekit-mobile';
import { expect, test, vi } from 'vitest';

const snapshot = (revision: number, overrides: Partial<NativeCallSnapshot> = {}) => ({
  revision,
  callId: '7',
  connectionState: 'connected' as const,
  microphoneEnabled: true,
  cameraEnabled: false,
  screenShareEnabled: false,
  participantCount: 1,
  remoteParticipants: [],
  ...overrides,
});

const plugin = {
  listenNativeCallSnapshot: vi.fn(() => Promise.resolve(() => undefined)),
  connectNativeCall: vi.fn(() => Promise.resolve(snapshot(1))),
  setNativeCallCameraEnabled: vi.fn(() => Promise.resolve(snapshot(2, { cameraEnabled: true }))),
  setNativeCallLocalVideoOverlay: vi.fn(() =>
    Promise.resolve(snapshot(3, { cameraEnabled: true }))
  ),
  clearNativeCallLocalVideoOverlay: vi.fn(() =>
    Promise.resolve(snapshot(4, { cameraEnabled: true }))
  ),
  setNativeCallRemoteVideoOverlay: vi.fn(() => Promise.resolve(snapshot(7))),
  clearNativeCallRemoteVideoOverlay: vi.fn(() => Promise.resolve(snapshot(8))),
  getAudioRoutes: vi.fn(() =>
    Promise.resolve({
      routes: [],
      inputs: [{ id: '12', name: 'Phone microphone', type: 'builtin_mic', current: true }],
      receiver: snapshot(5),
    })
  ),
  setAudioInput: vi.fn(() => Promise.resolve(snapshot(6))),
  setNativeCallParticipantVolume: vi.fn(() => Promise.resolve(snapshot(9))),
  disconnectNativeCall: vi.fn(() => Promise.resolve(snapshot(10))),
  reconcileNativeCallBackends: vi.fn(() => Promise.resolve(snapshot(11))),
};

const platform = vi.hoisted(() => ({ android: true }));

vi.mock('#lib/platform/calls.js', () => ({ loadNativeCalls: () => Promise.resolve(plugin) }));
vi.mock('#lib/platform/os.js', () => ({
  isAndroid: () => platform.android,
  isNativeMobile: () => false,
}));

const { createNativeTransport } = await import('./native-transport');

test('native screen audio is exposed separately from the microphone', async () => {
  const screenShareAudio = { sid: 'screen-audio', muted: false, subscribed: true };
  const remote = { identity: 'alice', screenShareAudio };
  plugin.connectNativeCall.mockResolvedValueOnce(
    snapshot(1, {
      remoteParticipants: [remote],
    })
  );
  const transport = await createNativeTransport('7', 'self');
  await transport?.connect({
    url: 'wss://sfu.example.org',
    token: 'jwt',
    microphoneEnabled: true,
    cameraEnabled: false,
    encryptionKeys: [],
  });
  expect(transport?.getState().participants[0].screenShareAudio).toEqual({
    id: 'screen-audio',
    muted: false,
    subscribed: true,
  });
  await transport?.setParticipantVolume?.('alice', 0.6, true);
  expect(plugin.setNativeCallParticipantVolume).toHaveBeenLastCalledWith({
    callId: '7',
    identity: 'alice',
    volume: 0.6,
    screenShare: true,
  });
  await transport?.setParticipantVolume?.('alice', 0.8);
  expect(plugin.setNativeCallParticipantVolume).toHaveBeenLastCalledWith({
    callId: '7',
    identity: 'alice',
    volume: 0.8,
    screenShare: false,
  });
});

test('the native transport reports our own participant with its camera', async () => {
  const transport = await createNativeTransport('7', '@kris:example.org:PHONE');
  await transport?.connect({
    url: 'wss://sfu.example.org',
    token: 'jwt',
    microphoneEnabled: true,
    cameraEnabled: false,
    encryptionKeys: [],
  });

  expect(transport?.getState().self).toMatchObject({
    identity: '@kris:example.org:PHONE',
    local: true,
    microphone: { muted: false },
  });
  expect(transport?.getState().self?.camera).toBeUndefined();

  await transport?.setCameraEnabled(true);
  expect(transport?.getState().self?.camera).toMatchObject({ muted: false });
});

test('the native transport names the system call on connect', async () => {
  const transport = await createNativeTransport('7', 'self', 'Room A');
  await transport?.connect({
    url: 'wss://sfu.example.org',
    token: 'jwt',
    microphoneEnabled: true,
    cameraEnabled: false,
    encryptionKeys: [],
  });

  expect(plugin.connectNativeCall).toHaveBeenLastCalledWith(
    expect.objectContaining({ callId: '7', callerName: 'Room A' })
  );
});

test('a hang-up during connect neither leaks the listener nor starts the call', async () => {
  const stop = vi.fn(() => undefined);
  let listening = (_stop: () => undefined) => {};
  plugin.listenNativeCallSnapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        listening = resolve;
      })
  );
  plugin.connectNativeCall.mockClear();
  const transport = await createNativeTransport('7', 'self', 'Room A');
  const connecting = transport?.connect({
    url: 'wss://sfu.example.org',
    token: 'jwt',
    microphoneEnabled: true,
    cameraEnabled: false,
    encryptionKeys: [],
  });

  await transport?.disconnect();
  listening(stop);
  await connecting;

  expect(stop).toHaveBeenCalledOnce();
  expect(plugin.connectNativeCall).not.toHaveBeenCalled();
});

test('the native transport places and clears the local video overlay', async () => {
  const transport = await createNativeTransport('7', '@kris:example.org:PHONE');
  const rect = { x: 1, y: 2, width: 3, height: 4, devicePixelRatio: 2 };

  await transport?.capabilities.localVideo?.place(rect);
  expect(plugin.setNativeCallLocalVideoOverlay).toHaveBeenCalledWith({ callId: '7', ...rect });

  await transport?.capabilities.localVideo?.clear();
  expect(plugin.clearNativeCallLocalVideoOverlay).toHaveBeenCalledWith({ callId: '7' });
});

test('the native transport places the remote video over a tile', async () => {
  const transport = await createNativeTransport('7', '@kris:example.org:PHONE');
  const rect = { x: 1, y: 2, width: 3, height: 4, devicePixelRatio: 2 };

  await transport?.capabilities.remoteVideo?.place({ ...rect, identity: 'bob', trackId: 'TR_1' });
  expect(plugin.setNativeCallRemoteVideoOverlay).toHaveBeenCalledWith({
    callId: '7',
    participantIdentity: 'bob',
    trackId: 'TR_1',
    ...rect,
  });

  await transport?.capabilities.remoteVideo?.clear('TR_1');
  expect(plugin.clearNativeCallRemoteVideoOverlay).toHaveBeenCalledWith({
    callId: '7',
    trackId: 'TR_1',
  });
});

test('the native transport lists and selects microphones on Android only', async () => {
  const transport = await createNativeTransport('7', '@kris:example.org:PHONE');

  expect(await transport?.capabilities.audioInputs?.list()).toEqual([
    { id: '12', name: 'Phone microphone', type: 'builtin_mic', current: true },
  ]);
  await transport?.capabilities.audioInputs?.select('12');
  expect(plugin.setAudioInput).toHaveBeenCalledWith({ callId: '7', inputId: '12' });

  platform.android = false;
  const ios = await createNativeTransport('7', '@kris:example.org:PHONE');
  expect(ios?.capabilities.audioInputs).toBeUndefined();
});

test('a multi-server call publishes on its own backend and subscribes to the others', async () => {
  vi.useFakeTimers();
  const backends = [
    { id: 'own', url: 'wss://own.example.org', jwt: 'own-jwt', identity: 'self' },
    { id: 'other', url: 'wss://other.example.org', jwt: 'other-jwt', identity: 'self' },
  ];
  plugin.connectNativeCall.mockClear();
  plugin.reconcileNativeCallBackends.mockClear();
  plugin.reconcileNativeCallBackends.mockResolvedValueOnce(snapshot(20));
  const transport = await createNativeTransport('7', 'self');
  await transport?.connect({
    url: 'wss://ignored.example.org',
    token: 'ignored',
    microphoneEnabled: true,
    cameraEnabled: false,
    encryptionKeys: [],
    publisherId: 'own',
    backends,
  });

  expect(plugin.connectNativeCall).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'wss://own.example.org', token: 'own-jwt' })
  );
  expect(plugin.reconcileNativeCallBackends).toHaveBeenCalledWith({
    callId: '7',
    publisherId: 'own',
    backends: [
      { id: 'own', url: 'wss://own.example.org', token: 'own-jwt' },
      { id: 'other', url: 'wss://other.example.org', token: 'other-jwt' },
    ],
  });
  expect(transport?.getState().unreachableBackends).toBeUndefined();

  plugin.reconcileNativeCallBackends.mockResolvedValueOnce(
    snapshot(21, { subscriberBackends: ['other'] })
  );
  await vi.advanceTimersByTimeAsync(2_000);
  expect(plugin.reconcileNativeCallBackends).toHaveBeenCalledTimes(2);
  expect(transport?.getState().unreachableBackends).toBeUndefined();

  await transport?.disconnect();
  vi.useRealTimers();
});

test('a backend that stays disconnected is reported unreachable and retried', async () => {
  vi.useFakeTimers();
  plugin.reconcileNativeCallBackends.mockClear();
  plugin.reconcileNativeCallBackends.mockImplementation(() => Promise.resolve(snapshot(30)));
  const transport = await createNativeTransport('7', 'self');
  await transport?.connect({
    url: 'wss://own.example.org',
    token: 'jwt',
    microphoneEnabled: true,
    cameraEnabled: false,
    encryptionKeys: [],
    publisherId: 'own',
    backends: [
      { id: 'own', url: 'wss://own.example.org', jwt: 'own-jwt', identity: 'self' },
      { id: 'other', url: 'wss://other.example.org', jwt: 'other-jwt', identity: 'self' },
    ],
  });

  await vi.advanceTimersByTimeAsync(2_000);
  expect(transport?.getState().unreachableBackends).toEqual(['other']);
  expect(plugin.reconcileNativeCallBackends).toHaveBeenCalledTimes(2);

  await transport?.disconnect();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(plugin.reconcileNativeCallBackends).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
