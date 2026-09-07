// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(), osType: vi.fn(), invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: mocks.osType }));

import { listPushDistributors, registerNativePushConfig } from './push';

import { deliversNativePush, deliversWebPush, presentsInApp } from './notifications';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the browser presents in app, and a native shell alerts through the OS', () => {
  // happy-dom has no Notification of its own.
  vi.stubGlobal('Notification', { permission: 'granted' });

  mocks.isTauri.mockReturnValue(false);
  expect(presentsInApp()).toBe(true);

  mocks.isTauri.mockReturnValue(true);
  expect(presentsInApp()).toBe(false);
});

test('a browser without the Notification API presents nothing', () => {
  mocks.isTauri.mockReturnValue(false);
  vi.stubGlobal('Notification', undefined);

  expect(presentsInApp()).toBe(false);
});

// Subscribing to the undefined `navigator.serviceWorker` is what crashed iOS.
test('a webview without a service worker takes no web push', () => {
  vi.stubGlobal('navigator', {});
  expect(deliversWebPush()).toBe(false);

  vi.stubGlobal('navigator', { serviceWorker: {} });
  vi.stubGlobal('PushManager', function PushManager() {});
  expect(deliversWebPush()).toBe(true);
});

test('only a mobile Tauri build registers a native pusher', async () => {
  mocks.isTauri.mockReturnValue(true);

  mocks.osType.mockReturnValue('ios');
  await expect(deliversNativePush()).resolves.toBe(true);

  mocks.osType.mockReturnValue('android');
  await expect(deliversNativePush()).resolves.toBe(true);

  mocks.osType.mockReturnValue('linux');
  await expect(deliversNativePush()).resolves.toBe(false);
});

test('a plain browser registers no native pusher', async () => {
  mocks.isTauri.mockReturnValue(false);
  await expect(deliversNativePush()).resolves.toBe(false);
});

test('distributor discovery is limited to Android', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockResolvedValue(['embedded-websocket', 'io.heckel.ntfy']);
  for (const platform of ['ios', 'macos', 'windows', 'linux']) {
    mocks.osType.mockReturnValue(platform);
    expect(await listPushDistributors()).toEqual([]);
  }
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.osType.mockReturnValue('android');
  expect(await listPushDistributors()).toEqual(['embedded-websocket', 'io.heckel.ntfy']);
  expect(mocks.invoke).toHaveBeenCalledWith('plugin:notifications|list_distributors');
});

test('forwards the built-in server and account through the native command', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('android');
  await registerNativePushConfig({
    gatewayUrl: 'https://push.example/_matrix/push/v1/notify',
    vapidKey: 'key',
    webAppId: 'web',
    nativeAppId: 'android',
    embeddedGatewayUrl: 'https://ntfy.example',
    eventIdOnly: false,
    userId: '@alice:example.org',
    deviceId: 'DEVICE',
  });
  expect(mocks.invoke).toHaveBeenLastCalledWith('register_push', {
    config: {
      gateway_url: 'https://push.example/_matrix/push/v1/notify',
      vapid_key: 'key',
      web_app_id: 'web',
      native_app_id: 'android',
      ios_app_id: null,
      unified_push_gateway_url: null,
      embedded_gateway_url: 'https://ntfy.example',
      user_id: '@alice:example.org',
      device_id: 'DEVICE',
      event_id_only: false,
    },
  });
});
