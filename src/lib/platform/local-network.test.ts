import { afterEach, expect, test, vi } from 'vitest';

import { invoke, isTauri } from '@tauri-apps/api/core';

import {
  browserGatesCoreNetwork,
  isLocalNetworkHost,
  LocalNetworkBlockedError,
  localNetworkDenied,
  withLocalNetworkAccess,
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

async function fresh() {
  vi.resetModules();
  const core = await import('@tauri-apps/api/core');
  const module = await import('./local-network');
  return { invoke: vi.mocked(core.invoke), request: module.requestAndroidLocalNetwork };
}

test('on Android it asks for local network access once and reports the grant', async () => {
  const { invoke, request } = await fresh();
  invoke.mockResolvedValueOnce({ localNetwork: 'prompt' });
  invoke.mockResolvedValueOnce({ localNetwork: 'granted' });

  expect(await request()).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith('plugin:sable-push|request_permissions', {
    permissions: ['localNetwork'],
  });

  expect(await request()).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(2);
});

test('a settled permission is not asked for again', async () => {
  const { invoke, request } = await fresh();
  invoke.mockResolvedValue({ localNetwork: 'granted' });

  expect(await request()).toBe(false);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin:sable-push|check_permissions');
});

test('a refusal or another platform leaves access blocked', async () => {
  const { invoke, request } = await fresh();
  invoke.mockResolvedValueOnce({ localNetwork: 'prompt' });
  invoke.mockResolvedValueOnce({ localNetwork: 'denied' });
  expect(await request()).toBe(false);

  android.value = false;
  invoke.mockClear();
  const other = await fresh();
  expect(await other.request()).toBe(false);
  expect(other.invoke).not.toHaveBeenCalled();
});

async function freshOffer() {
  vi.resetModules();
  const core = await import('@tauri-apps/api/core');
  const module = await import('./local-network');
  return { invoke: vi.mocked(core.invoke), ...module };
}

test('the Android prompt is offered only while the system would still show it', async () => {
  const unasked = await freshOffer();
  unasked.invoke.mockResolvedValue({ localNetwork: 'prompt' });
  expect(await unasked.androidLocalNetworkUnasked()).toBe(true);

  const settled = await freshOffer();
  settled.invoke.mockResolvedValue({ localNetwork: 'denied' });
  expect(await settled.androidLocalNetworkUnasked()).toBe(false);

  android.value = false;
  const elsewhere = await freshOffer();
  elsewhere.invoke.mockClear();
  expect(await elsewhere.androidLocalNetworkUnasked()).toBe(false);
  expect(elsewhere.invoke).not.toHaveBeenCalled();
});

test('declining the offer keeps it away until the next launch', async () => {
  const first = await freshOffer();
  first.invoke.mockResolvedValue({ localNetwork: 'prompt' });
  first.declineAndroidLocalNetwork();
  expect(await first.androidLocalNetworkUnasked()).toBe(false);

  const relaunched = await freshOffer();
  relaunched.invoke.mockResolvedValue({ localNetwork: 'prompt' });
  expect(await relaunched.androidLocalNetworkUnasked()).toBe(true);
});

test.each([
  ['192.168.1.20', true],
  ['10.0.0.5', true],
  ['172.16.0.1', true],
  ['172.32.0.1', false],
  ['127.0.0.1', true],
  ['169.254.1.1', true],
  ['[::1]', true],
  ['[fd00::1]', true],
  ['localhost', true],
  ['sfu.local', true],
  ['sfu.example.org', false],
  ['8.8.8.8', false],
])('%s is local network: %s', (host, expected) => {
  expect(isLocalNetworkHost(host)).toBe(expected);
});

test('a failed connect to a private call server probes the origin and retries once when granted', async () => {
  android.value = false;
  const fetchMock = vi.fn().mockResolvedValue({});
  vi.stubGlobal('fetch', fetchMock);
  const connect = vi.fn().mockRejectedValueOnce(new Error('connect')).mockResolvedValue(undefined);

  await withLocalNetworkAccess('wss://192.168.1.20:7880', connect);

  expect(fetchMock).toHaveBeenCalledWith(new URL('https://192.168.1.20:7880'), {
    mode: 'no-cors',
  });
  expect(connect).toHaveBeenCalledTimes(2);
});

test('a private call server that stays blocked reports the local network', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('blocked')));
  android.value = false;
  const connect = vi.fn().mockRejectedValue(new Error('connect'));

  await expect(withLocalNetworkAccess('wss://sfu.local', connect)).rejects.toEqual(
    new LocalNetworkBlockedError('sfu.local')
  );
  expect(connect).toHaveBeenCalledOnce();
});

test('a public call server is never probed', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const failure = new Error('connect');
  const connect = vi.fn().mockRejectedValue(failure);

  await expect(withLocalNetworkAccess('wss://sfu.example.org', connect)).rejects.toBe(failure);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledOnce();
});

test('on Android a failed connect to a private call server asks for access and retries once', async () => {
  const { invoke } = await fresh();
  const { withLocalNetworkAccess } = await import('./local-network');
  invoke.mockResolvedValueOnce({ localNetwork: 'prompt' });
  invoke.mockResolvedValueOnce({ localNetwork: 'granted' });
  const connect = vi.fn().mockRejectedValueOnce(new Error('connect')).mockResolvedValue(undefined);

  await withLocalNetworkAccess('wss://192.168.1.20:7880', connect);

  expect(connect).toHaveBeenCalledTimes(2);
});

test('on Android a refused local network keeps the original call error', async () => {
  const { invoke } = await fresh();
  const { withLocalNetworkAccess } = await import('./local-network');
  invoke.mockResolvedValueOnce({ localNetwork: 'prompt' });
  invoke.mockResolvedValueOnce({ localNetwork: 'denied' });
  const failure = new Error('connect');
  const connect = vi.fn().mockRejectedValue(failure);

  await expect(withLocalNetworkAccess('wss://sfu.local', connect)).rejects.toBe(failure);
  expect(connect).toHaveBeenCalledOnce();
});
