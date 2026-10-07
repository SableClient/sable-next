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
};

const platform = vi.hoisted(() => ({ android: true }));

vi.mock('#lib/platform/calls.js', () => ({ loadNativeCalls: () => Promise.resolve(plugin) }));
vi.mock('#lib/platform/os.js', () => ({ isAndroid: () => platform.android }));

const { createNativeTransport } = await import('./native-transport');

test('the native transport reports our own participant with its camera', async () => {
  const transport = await createNativeTransport('7', '@erwan:example.org:PHONE');
  await transport?.connect({
    url: 'wss://sfu.example.org',
    token: 'jwt',
    microphoneEnabled: true,
    cameraEnabled: false,
    encryptionKeys: [],
  });

  expect(transport?.getState().self).toMatchObject({
    identity: '@erwan:example.org:PHONE',
    local: true,
    microphone: { muted: false },
  });
  expect(transport?.getState().self?.camera).toBeUndefined();

  await transport?.setCameraEnabled(true);
  expect(transport?.getState().self?.camera).toMatchObject({ muted: false });
});

test('the native transport places and clears the local video overlay', async () => {
  const transport = await createNativeTransport('7', '@erwan:example.org:PHONE');
  const rect = { x: 1, y: 2, width: 3, height: 4, devicePixelRatio: 2 };

  await transport?.capabilities.localVideo?.place(rect);
  expect(plugin.setNativeCallLocalVideoOverlay).toHaveBeenCalledWith({ callId: '7', ...rect });

  await transport?.capabilities.localVideo?.clear();
  expect(plugin.clearNativeCallLocalVideoOverlay).toHaveBeenCalledWith({ callId: '7' });
});

test('the native transport places the remote video over a tile', async () => {
  const transport = await createNativeTransport('7', '@erwan:example.org:PHONE');
  const rect = { x: 1, y: 2, width: 3, height: 4, devicePixelRatio: 2 };

  await transport?.capabilities.remoteVideo?.place({ ...rect, identity: 'bob', trackId: 'TR_1' });
  expect(plugin.setNativeCallRemoteVideoOverlay).toHaveBeenCalledWith({
    callId: '7',
    participantIdentity: 'bob',
    trackId: 'TR_1',
    ...rect,
  });

  await transport?.capabilities.remoteVideo?.clear();
  expect(plugin.clearNativeCallRemoteVideoOverlay).toHaveBeenCalledWith({ callId: '7' });
});

test('the native transport lists and selects microphones on Android only', async () => {
  const transport = await createNativeTransport('7', '@erwan:example.org:PHONE');

  expect(await transport?.capabilities.audioInputs?.list()).toEqual([
    { id: '12', name: 'Phone microphone', type: 'builtin_mic', current: true },
  ]);
  await transport?.capabilities.audioInputs?.select('12');
  expect(plugin.setAudioInput).toHaveBeenCalledWith({ callId: '7', inputId: '12' });

  platform.android = false;
  const ios = await createNativeTransport('7', '@erwan:example.org:PHONE');
  expect(ios?.capabilities.audioInputs).toBeUndefined();
});
