import type { NativePushConfig } from '#lib/platform/push.js';

import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  register: vi.fn<(config: NativePushConfig) => Promise<void>>(),
  list: vi.fn(),
  select: vi.fn<(name: string) => Promise<void>>(),
  config: vi.fn(),
  native: vi.fn(),
}));

vi.mock('#lib/platform/push.js', () => ({
  registerNativePushConfig: mocks.register,
  listPushDistributors: mocks.list,
  setPushDistributor: mocks.select,
}));
vi.mock('#lib/platform/notifications.js', () => ({ deliversNativePush: mocks.native }));
vi.mock('#lib/settings/preferences.svelte.js', () => ({ preferences: { richPushPayloads: true } }));
vi.mock('./push-config', () => ({ pushConfig: mocks.config }));

import {
  registerNativePush,
  selectedPushDistributor,
  switchPushDistributor,
  switchPushProvider,
} from './native-push';

const session = { account_id: 'account', user_id: '@alice:example.org', device_id: 'DEVICE' };
const override = { pushGatewayUrl: '', pushVapidKey: '', pushAppId: '' };
const config = {
  resolved: { gateway: 'https://push.example/_matrix/push/v1/notify', vapid: 'key', appId: 'web' },
  details: {
    pushNotifyUrl: 'https://push.example/_matrix/push/v1/notify',
    nativePushAppID: 'android',
    iosPushAppID: 'ios',
    unifiedPushGatewayUrl: 'https://up.example/_matrix/push/v1/notify',
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => {
      stored.delete(key);
    },
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  });
  mocks.native.mockResolvedValue(true);
  mocks.list.mockResolvedValue(['embedded-websocket', 'io.heckel.ntfy', 'org.example.sunup']);
  mocks.config.mockResolvedValue(config);
  mocks.register.mockResolvedValue(undefined);
  mocks.select.mockResolvedValue(undefined);
});

test('registers the built-in gateway and preserves native and UnifiedPush routing', async () => {
  await registerNativePush(override, session);
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({
      embeddedGatewayUrl: 'https://ntfy.sh',
      unifiedPushGatewayUrl: config.details.unifiedPushGatewayUrl,
      nativeAppId: 'android',
      iosAppId: 'ios',
      userId: session.user_id,
      deviceId: session.device_id,
      eventIdOnly: false,
    })
  );
  expect(mocks.select).not.toHaveBeenCalled();
});

test('passes the selected native provider to the plugin', async () => {
  localStorage.setItem('sable.push.provider', 'fcm');
  await registerNativePush(override, session);
  expect(mocks.register.mock.calls[0][0].provider).toBe('fcm');
});

test('switches to UnifiedPush and selects an installed distributor', async () => {
  await switchPushProvider('unifiedpush', override, session);
  expect(mocks.select).toHaveBeenCalledWith('io.heckel.ntfy');
  expect(mocks.register.mock.calls[0][0].provider).toBe('unifiedpush');
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('uses a deployment-provided built-in server', async () => {
  mocks.config.mockResolvedValue({
    ...config,
    details: { ...config.details, unifiedPushEmbeddedServerUrl: 'https://ntfy.example' },
  });
  await registerNativePush(override, session);
  expect(mocks.register.mock.calls[0][0].embeddedGatewayUrl).toBe('https://ntfy.example');
});

test.each(['embedded-websocket', 'io.heckel.ntfy', 'org.example.sunup'])(
  'saves %s only after registration succeeds',
  async (name) => {
    mocks.register.mockImplementation(() => {
      expect(mocks.select).toHaveBeenCalledWith(name);
      expect(selectedPushDistributor()).toBe('');
      return Promise.resolve();
    });
    await switchPushDistributor(name, override, session);
    expect(selectedPushDistributor()).toBe(name);
  }
);

test('restores the previous distributor and pusher when switching fails', async () => {
  await switchPushDistributor('io.heckel.ntfy', override, session);
  mocks.register.mockRejectedValueOnce(new Error('gateway offline'));
  await expect(switchPushDistributor('embedded-websocket', override, session)).rejects.toThrow(
    'gateway offline'
  );
  expect(mocks.select.mock.calls.map(([name]) => name)).toEqual([
    'io.heckel.ntfy',
    'embedded-websocket',
    'io.heckel.ntfy',
  ]);
  expect(mocks.register).toHaveBeenCalledTimes(3);
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('rejects unavailable distributors without changing registration', async () => {
  await expect(switchPushDistributor('missing', override, session)).rejects.toThrow(
    'not available'
  );
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
});

test('does not change distributors without a gateway or signed-in session', async () => {
  await expect(switchPushDistributor('embedded-websocket', override, null)).rejects.toThrow(
    'Sign in'
  );
  mocks.config.mockResolvedValue({ resolved: null, details: null });
  await expect(switchPushDistributor('embedded-websocket', override, session)).rejects.toThrow(
    'not configured'
  );
  expect(mocks.select).not.toHaveBeenCalled();
});

test('waits for startup registration before switching distributors', async () => {
  let release = (): void => {};
  mocks.register.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const startup = registerNativePush(override, session);
  await vi.waitFor(() => {
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  const switching = switchPushDistributor('io.heckel.ntfy', override, session);
  await Promise.resolve();
  expect(mocks.select).not.toHaveBeenCalled();
  release();
  await Promise.all([startup, switching]);
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('a failed switch does not block a later retry', async () => {
  mocks.register.mockRejectedValueOnce(new Error('offline'));
  await expect(switchPushDistributor('io.heckel.ntfy', override, session)).rejects.toThrow(
    'offline'
  );
  expect(selectedPushDistributor()).toBe('');
  await switchPushDistributor('io.heckel.ntfy', override, session);
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('does not register native push in the browser', async () => {
  mocks.native.mockResolvedValue(false);
  await registerNativePush(override, session);
  expect(mocks.register).not.toHaveBeenCalled();
});

test('does not display a saved distributor when restoring it also fails', async () => {
  await switchPushDistributor('io.heckel.ntfy', override, session);
  mocks.register.mockRejectedValue(new Error('offline'));
  await expect(switchPushDistributor('embedded-websocket', override, session)).rejects.toThrow(
    'offline'
  );
  expect(selectedPushDistributor()).toBe('');
});
