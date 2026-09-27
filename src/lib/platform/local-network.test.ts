import { afterEach, expect, test, vi } from 'vitest';

import { isTauri } from '@tauri-apps/api/core';

import { browserGatesCoreNetwork, localNetworkDenied } from './local-network';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false) }));

afterEach(() => {
  vi.unstubAllGlobals();
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
