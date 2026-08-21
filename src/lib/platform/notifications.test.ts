// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(), osType: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: mocks.osType }));

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
