// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: vi.fn().mockResolvedValue('denied'),
  request: vi.fn().mockResolvedValue('granted'),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'android' }));
vi.mock('#lib/platform/native-notifications.js', () => ({
  nativeNotificationPermission: mocks.state,
  requestNativeNotificationPermission: mocks.request,
}));

import { grantPermission, permissionGranted } from './present';

test('a native shell reports the platform permission, not the webview one', async () => {
  await expect(permissionGranted()).resolves.toBe(false);
  expect(mocks.state).toHaveBeenCalled();
});

test('a native shell asks the platform to grant it', async () => {
  await expect(grantPermission()).resolves.toBe(true);
  expect(mocks.request).toHaveBeenCalled();
});
