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
};

vi.mock('#lib/platform/calls.js', () => ({ loadNativeCalls: () => Promise.resolve(plugin) }));

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
