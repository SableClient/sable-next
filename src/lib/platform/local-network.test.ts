import { afterEach, expect, test, vi } from 'vitest';

import { invoke, isTauri } from '@tauri-apps/api/core';

import {
  browserGatesCoreNetwork,
  localNetworkDenied,
  requestAndroidLocalNetwork,
} from './local-network';

const android = vi.hoisted(() => ({ value: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock('./os.js', () => ({ isAndroid: () => android.value }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(invoke).mockReset();
  android.value = true;
});

test('only the browser gates the core network', () => {
  expect(browserGatesCoreNetwork()).toBe(true);
  vi.mocked(isTauri).mockReturnValueOnce(true);
  expect(browserGatesCoreNetwork()).toBe(false);
});

test('a denial under any permission name counts', async () => {
  const query = vi.fn(({ name }: { name: string }) =>
    name === 'local-network-access'
      ? Promise.resolve({ state: 'denied' })
      : Promise.reject(new TypeError(`unknown permission ${name}`))
  );
  vi.stubGlobal('navigator', { permissions: { query } });

  expect(await localNetworkDenied()).toBe(true);
});

test('a browser without the permission reports nothing denied', async () => {
  vi.stubGlobal('navigator', {
    permissions: { query: () => Promise.reject(new TypeError('unknown permission')) },
  });
  expect(await localNetworkDenied()).toBe(false);

  vi.stubGlobal('navigator', {});
  expect(await localNetworkDenied()).toBe(false);
});

test('on Android it asks for local network access and reports the grant', async () => {
  vi.mocked(invoke).mockResolvedValue({ localNetwork: 'granted' });

  expect(await requestAndroidLocalNetwork()).toBe(true);
  expect(invoke).toHaveBeenCalledWith('plugin:sable-push|request_permissions', {
    permissions: ['localNetwork'],
  });
});

test('a refusal or another platform leaves access blocked', async () => {
  vi.mocked(invoke).mockResolvedValue({ localNetwork: 'denied' });
  expect(await requestAndroidLocalNetwork()).toBe(false);

  android.value = false;
  vi.mocked(invoke).mockClear();
  expect(await requestAndroidLocalNetwork()).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
