import type { NativePushAccount, NativePushConfig } from '#lib/platform/push.js';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  register: vi.fn<(config: NativePushConfig) => Promise<void>>(),
  unregister: vi.fn<(account?: NativePushAccount) => Promise<void>>(),
  list: vi.fn(),
  select: vi.fn<(name: string) => Promise<void>>(),
  config: vi.fn(),
  native: vi.fn(),
}));

vi.mock('#lib/platform/push.js', () => ({
  registerNativePushConfig: mocks.register,
  unregisterNativePushConfig: mocks.unregister,
  listPushDistributors: mocks.list,
  setPushDistributor: mocks.select,
}));
vi.mock('#lib/platform/notifications.js', () => ({ deliversNativePush: mocks.native }));
const preferences = vi.hoisted(() => ({ richPushPayloads: true, pushEmbeddedServerUrl: '' }));
vi.mock('#lib/settings/preferences.svelte.js', () => ({ preferences }));
vi.mock('#lib/notifications/push-config.js', async (original) => ({
  ...(await original<typeof import('#lib/notifications/push-config.js')>()),
  pushConfig: mocks.config,
}));

import {
  NoDistributorError,
  registerNativePush,
  retryNativePushNow,
  selectedPushDistributor,
  switchPushDistributor,
  switchPushProvider,
  unregisterNativePush,
} from './native-push';

const session = {
  account_id: 'account',
  user_id: '@alice:example.org',
  device_id: 'DEVICE',
  homeserver: 'https://example.org',
  needs_reauth: false,
};
const other = {
  account_id: 'other',
  user_id: '@bob:example.org',
  device_id: 'OTHER',
  homeserver: 'https://example.org',
  needs_reauth: false,
};
const accounts = [session, other];
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
  mocks.native.mockReturnValue(true);
  mocks.list.mockResolvedValue(['embedded-websocket', 'io.heckel.ntfy', 'org.example.sunup']);
  mocks.config.mockResolvedValue(config);
  mocks.register.mockResolvedValue(undefined);
  mocks.unregister.mockResolvedValue(undefined);
  mocks.select.mockResolvedValue(undefined);
});

afterEach(async () => {
  await unregisterNativePush();
  vi.useRealTimers();
});

test('registers the built-in gateway and preserves native and UnifiedPush routing', async () => {
  await registerNativePush(override, session, accounts);
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

test('registers once for identical requests made while one is pending', async () => {
  const first = registerNativePush(override, session, accounts);
  const second = registerNativePush(override, session, accounts);
  await Promise.all([first, second]);
  expect(mocks.register).toHaveBeenCalledTimes(1);

  await registerNativePush(override, session, accounts);
  expect(mocks.register).toHaveBeenCalledTimes(2);
});

test('still registers a request that differs from the pending one', async () => {
  await Promise.all([
    registerNativePush(override, session, accounts),
    registerNativePush(override, other, accounts),
  ]);
  expect(mocks.register).toHaveBeenCalledTimes(2);
});

test('registers again when message text is turned off during a registration', async () => {
  const first = registerNativePush(override, session, accounts);
  preferences.richPushPayloads = false;
  const second = registerNativePush(override, session, accounts);
  await Promise.all([first, second]);
  preferences.richPushPayloads = true;

  expect(mocks.register).toHaveBeenCalledTimes(2);
  expect(mocks.register.mock.lastCall?.[0].eventIdOnly).toBe(true);
});

test('declares every signed-in account, not only the active one', async () => {
  const reauth = {
    ...other,
    account_id: 'stale',
    user_id: '@carol:example.org',
    needs_reauth: true,
  };
  await registerNativePush(override, session, [...accounts, reauth]);
  expect(mocks.register.mock.calls[0][0].accounts).toEqual([
    { userId: session.user_id, deviceId: session.device_id },
    { userId: other.user_id, deviceId: other.device_id },
  ]);
});

test('passes the selected native provider to the plugin', async () => {
  localStorage.setItem('sable.push.provider', 'fcm');
  await registerNativePush(override, session, accounts);
  expect(mocks.register.mock.calls[0][0].provider).toBe('fcm');
});

test('uses an explicit gateway app ID for iOS', async () => {
  const custom = {
    pushGatewayUrl: 'https://custom.example/notify',
    pushVapidKey: 'key',
    pushAppId: 'custom.ios',
  };
  mocks.config.mockResolvedValue({
    ...config,
    resolved: { gateway: custom.pushGatewayUrl, vapid: 'key', appId: custom.pushAppId },
  });
  await registerNativePush(custom, session, accounts);
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({
      gatewayOverride: true,
      iosAppId: 'custom.ios',
      gatewayUrl: custom.pushGatewayUrl,
    })
  );
});

test('switches to UnifiedPush and selects an installed distributor', async () => {
  await switchPushProvider('unifiedpush', override, session, accounts);
  expect(mocks.select).toHaveBeenCalledWith('io.heckel.ntfy');
  expect(mocks.register.mock.calls[0][0].provider).toBe('unifiedpush');
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('reports a missing UnifiedPush app apart from other failures', async () => {
  mocks.list.mockResolvedValue(['embedded-websocket']);
  await expect(
    switchPushProvider('unifiedpush', override, session, accounts)
  ).rejects.toBeInstanceOf(NoDistributorError);
});

test('uses a deployment-provided built-in server', async () => {
  mocks.config.mockResolvedValue({
    ...config,
    details: { ...config.details, unifiedPushEmbeddedServerUrl: 'https://ntfy.example' },
  });
  await registerNativePush(override, session, accounts);
  expect(mocks.register.mock.calls[0][0].embeddedGatewayUrl).toBe('https://ntfy.example');
});

test('a server picked in settings wins over the deployment one', async () => {
  mocks.config.mockResolvedValue({
    ...config,
    details: { ...config.details, unifiedPushEmbeddedServerUrl: 'https://ntfy.example' },
  });
  preferences.pushEmbeddedServerUrl = 'https://ntfy.mine.example';
  await registerNativePush(override, session, accounts);
  preferences.pushEmbeddedServerUrl = '';
  expect(mocks.register.mock.calls[0][0].embeddedGatewayUrl).toBe('https://ntfy.mine.example');
});

test('registers again when the built-in server changes', async () => {
  await registerNativePush(override, session, accounts);
  preferences.pushEmbeddedServerUrl = 'https://ntfy.mine.example';
  await registerNativePush(override, session, accounts);
  preferences.pushEmbeddedServerUrl = '';
  expect(mocks.register).toHaveBeenCalledTimes(2);
  expect(mocks.register.mock.lastCall?.[0].embeddedGatewayUrl).toBe('https://ntfy.mine.example');
});

test.each(['embedded-websocket', 'io.heckel.ntfy', 'org.example.sunup'])(
  'saves %s only after registration succeeds',
  async (name) => {
    mocks.register.mockImplementation(() => {
      expect(mocks.select).toHaveBeenCalledWith(name);
      expect(selectedPushDistributor()).toBe('');
      return Promise.resolve();
    });
    await switchPushDistributor(name, override, session, accounts);
    expect(selectedPushDistributor()).toBe(name);
  }
);

test('restores the previous distributor and pusher when switching fails', async () => {
  await switchPushDistributor('io.heckel.ntfy', override, session, accounts);
  mocks.register.mockRejectedValueOnce(new Error('gateway offline'));
  await expect(
    switchPushDistributor('embedded-websocket', override, session, accounts)
  ).rejects.toThrow('gateway offline');
  expect(mocks.select.mock.calls.map(([name]) => name)).toEqual([
    'io.heckel.ntfy',
    'embedded-websocket',
    'io.heckel.ntfy',
  ]);
  expect(mocks.register).toHaveBeenCalledTimes(3);
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('rejects unavailable distributors without changing registration', async () => {
  await expect(switchPushDistributor('missing', override, session, accounts)).rejects.toThrow(
    'not available'
  );
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
});

test('does not change distributors without a gateway or signed-in session', async () => {
  await expect(
    switchPushDistributor('embedded-websocket', override, null, accounts)
  ).rejects.toThrow('Sign in');
  mocks.config.mockResolvedValue({ resolved: null, details: null });
  await expect(
    switchPushDistributor('embedded-websocket', override, session, accounts)
  ).rejects.toThrow('not configured');
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
  const startup = registerNativePush(override, session, accounts);
  await vi.waitFor(() => {
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  const switching = switchPushDistributor('io.heckel.ntfy', override, session, accounts);
  await Promise.resolve();
  expect(mocks.select).not.toHaveBeenCalled();
  release();
  await Promise.all([startup, switching]);
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('a failed switch does not block a later retry', async () => {
  mocks.register.mockRejectedValueOnce(new Error('offline'));
  await expect(
    switchPushDistributor('io.heckel.ntfy', override, session, accounts)
  ).rejects.toThrow('offline');
  expect(selectedPushDistributor()).toBe('');
  await switchPushDistributor('io.heckel.ntfy', override, session, accounts);
  expect(selectedPushDistributor()).toBe('io.heckel.ntfy');
});

test('does not register native push in the browser', async () => {
  mocks.native.mockReturnValue(false);
  await registerNativePush(override, session, accounts);
  expect(mocks.register).not.toHaveBeenCalled();
});

test('does not display a saved distributor when restoring it also fails', async () => {
  await switchPushDistributor('io.heckel.ntfy', override, session, accounts);
  mocks.register.mockRejectedValue(new Error('offline'));
  await expect(
    switchPushDistributor('embedded-websocket', override, session, accounts)
  ).rejects.toThrow('offline');
  expect(selectedPushDistributor()).toBe('');
});

const timedOut = new Error('Timed out registering for push notifications');

test('retries a registration that timed out, backing off until it succeeds', async () => {
  vi.useFakeTimers();
  mocks.register.mockRejectedValueOnce(timedOut).mockRejectedValueOnce(timedOut);

  await expect(registerNativePush(override, session, accounts)).rejects.toBe(timedOut);
  expect(mocks.register).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(14_999);
  expect(mocks.register).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.register).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.register).toHaveBeenCalledTimes(3);

  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(mocks.register).toHaveBeenCalledTimes(3);
});

test('keeps retrying at the longest delay while registration keeps failing', async () => {
  vi.useFakeTimers();
  mocks.register.mockRejectedValue(timedOut);

  await expect(registerNativePush(override, session, accounts)).rejects.toBe(timedOut);
  await vi.advanceTimersByTimeAsync(15_000 + 60_000 + 300_000);
  expect(mocks.register).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(mocks.register).toHaveBeenCalledTimes(5);
});

test('does not retry a failure that waiting cannot fix', async () => {
  vi.useFakeTimers();
  mocks.config.mockResolvedValue({ resolved: null, details: null });

  await expect(registerNativePush(override, session, accounts)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(mocks.register).not.toHaveBeenCalled();
});

test('registers again as soon as the app returns while a registration is failing', async () => {
  vi.useFakeTimers();
  mocks.register.mockRejectedValueOnce(timedOut);

  await expect(registerNativePush(override, session, accounts)).rejects.toBe(timedOut);
  await retryNativePushNow();
  expect(mocks.register).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(mocks.register).toHaveBeenCalledTimes(2);
});

test('returning to the app does nothing when nothing is failing', async () => {
  await registerNativePush(override, session, accounts);
  await retryNativePushNow();
  expect(mocks.register).toHaveBeenCalledTimes(1);
});

test('turning native push off cancels a pending retry', async () => {
  vi.useFakeTimers();
  mocks.register.mockRejectedValue(timedOut);

  await expect(registerNativePush(override, session, accounts)).rejects.toBe(timedOut);
  await unregisterNativePush();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(mocks.register).toHaveBeenCalledTimes(1);
});

test('logging out another account preserves an in-flight registration and its retry', async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<undefined>();
  mocks.register.mockReturnValueOnce(pending.promise);

  const registration = registerNativePush(override, other, accounts);
  await vi.waitFor(() => {
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  const logout = unregisterNativePush(session);
  pending.reject(timedOut);
  await expect(registration).rejects.toBe(timedOut);
  await logout;

  expect(mocks.unregister).toHaveBeenCalledWith(session);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.register).toHaveBeenCalledTimes(2);
  expect(mocks.register.mock.lastCall?.[0]).toMatchObject({
    userId: other.user_id,
    deviceId: other.device_id,
    accounts: [{ userId: other.user_id, deviceId: other.device_id }],
  });
});

test('logging out the failing account cancels only its retry', async () => {
  vi.useFakeTimers();
  mocks.register.mockRejectedValueOnce(timedOut);

  await expect(registerNativePush(override, session, accounts)).rejects.toBe(timedOut);
  await unregisterNativePush(session);
  await vi.advanceTimersByTimeAsync(3_600_000);

  expect(mocks.unregister).toHaveBeenCalledWith(session);
  expect(mocks.register).toHaveBeenCalledTimes(1);
});

test('logging out another device of the same user preserves the active device retry', async () => {
  vi.useFakeTimers();
  mocks.register.mockRejectedValueOnce(timedOut);

  await expect(registerNativePush(override, session, accounts)).rejects.toBe(timedOut);
  await unregisterNativePush({ user_id: session.user_id, device_id: 'PREVIOUS' });
  await vi.advanceTimersByTimeAsync(15_000);

  expect(mocks.register).toHaveBeenCalledTimes(2);
  expect(mocks.register.mock.lastCall?.[0].deviceId).toBe(session.device_id);
});
