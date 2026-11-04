// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

const mocks = vi.hoisted(() => ({
  deliversWebPush: vi.fn<() => boolean>(),
  activeServiceWorker: vi.fn<() => Promise<unknown>>(),
  runtimeConfig: vi.fn<() => Promise<{ push: unknown }>>(),
  expectPushActivation: vi.fn<(userId: string) => Promise<void>>(),
  forgetPushSession: vi.fn<(userId: string) => Promise<void>>(),
  unregisterNativePush: vi.fn(),
}));

vi.mock('#lib/platform/notifications.js', () => ({
  deliversWebPush: mocks.deliversWebPush,
}));
vi.mock('#lib/platform/service-worker.js', () => ({
  activeServiceWorker: mocks.activeServiceWorker,
}));
vi.mock('#lib/config/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/config/runtime-config.js')>()),
  runtimeConfig: mocks.runtimeConfig,
}));
vi.mock('#lib/notifications/room-names.js', () => ({
  expectPushActivation: mocks.expectPushActivation,
  forgetPushSession: mocks.forgetPushSession,
}));
vi.mock('./native-push', () => ({ unregisterNativePush: mocks.unregisterNativePush }));
vi.mock('#lib/settings/preferences.svelte.js', () => ({
  preferences: { richPushPayloads: true },
}));

import {
  applicationServerKeyMatches,
  currentPushKey,
  logoutWithPush,
  needsRegistering,
  pusherDisplayName,
  registrationMarker,
  syncPushSubscription,
  vapidBytes,
  WEBPUSH_APP_ID,
} from './web-push';
import { writeText } from '#lib/platform/local-json.js';

const shipped = {
  gateway: 'https://sygnal.sable.moe/_matrix/push/v1/notify',
  appId: 'moe.sable.app.sygnal',
  vapid: 'cd2ON9yidLJ-CC_AmKKNgcTpgsHiueDBxPmyBZFTfik',
};

const server = {
  gateway: null,
  appId: WEBPUSH_APP_ID,
  vapid: 'server-key',
};

test('a VAPID key decodes from base64url whether or not it is padded', () => {
  // The key Sable ships in v1's config, which has no padding of its own.
  const key =
    'BCnS4SbHjeOaqVFW4wjt5xDt_pYIL62qMzKePfYF9fl9PQU14RieIaObh7nLR_9dQf4sykZa-CTrcjkgMIE1mcg';
  const bytes = vapidBytes(key);

  // An uncompressed P-256 point: 65 bytes, leading 0x04.
  expect(bytes).toHaveLength(65);
  expect(bytes[0]).toBe(0x04);
});

test('a rotated endpoint has to be registered again', () => {
  const first = registrationMarker('account-a', 'https://push.example/a', shipped, false);
  const second = registrationMarker('account-a', 'https://push.example/b', shipped, false);

  expect(needsRegistering(first, null)).toBe(true);
  expect(needsRegistering(first, second)).toBe(true);
  expect(needsRegistering(first, first)).toBe(false);
});

test('retargeting the gateway re-registers though the endpoint is unchanged', () => {
  const endpoint = 'https://push.example/a';
  const mine = {
    gateway: 'https://mine.example/_matrix/push/v1/notify',
    appId: 'org.example.web',
    vapid: 'my-key',
  };

  const before = registrationMarker('account-a', endpoint, shipped, false);
  expect(needsRegistering(registrationMarker('account-a', endpoint, mine, false), before)).toBe(
    true
  );
});

test('a server delivering web push itself is a distinct marker from any gateway', () => {
  const endpoint = 'https://push.example/a';

  expect(
    needsRegistering(
      registrationMarker('account-a', endpoint, server, false),
      registrationMarker('account-a', endpoint, shipped, false)
    )
  ).toBe(true);
  expect(
    needsRegistering(
      registrationMarker('account-a', endpoint, server, false),
      registrationMarker('account-a', endpoint, server, false)
    )
  ).toBe(false);
});

const SERVER_KEY =
  'BCnS4SbHjeOaqVFW4wjt5xDt_pYIL62qMzKePfYF9fl9PQU14RieIaObh7nLR_9dQf4sykZa-CTrcjkgMIE1mcg';

test('a subscription matches only the server key it was minted with', () => {
  const key = vapidBytes(SERVER_KEY);

  const subscription = {
    options: { applicationServerKey: key.slice() },
  } as unknown as PushSubscription;
  expect(applicationServerKeyMatches(subscription, SERVER_KEY)).toBe(true);
  expect(applicationServerKeyMatches(subscription, shipped.vapid)).toBe(false);

  const asBuffer = { options: { applicationServerKey: key.buffer } } as PushSubscription;
  expect(applicationServerKeyMatches(asBuffer, SERVER_KEY)).toBe(true);

  const bare = {} as PushSubscription;
  expect(applicationServerKeyMatches(bare, SERVER_KEY)).toBe(false);
});

type Commands = {
  webPusherSupport: ReturnType<typeof vi.fn>;
  webPushers: ReturnType<typeof vi.fn>;
  setPusher: ReturnType<typeof vi.fn>;
  setWebPusher: ReturnType<typeof vi.fn>;
  removePusher: ReturnType<typeof vi.fn>;
};

const NONE = { pushGatewayUrl: '', pushVapidKey: '', pushAppId: '' };

const SYGNAL = {
  pushNotifyUrl: shipped.gateway,
  vapidPublicKey: shipped.vapid,
  webPushAppID: shipped.appId,
  nativePushAppID: 'moe.sable.client.android',
};

const ENDPOINT = 'https://push.example/sub/1';
const KEYS = { p256dh: 'keys-p256dh', auth: 'keys-auth' };

/** A registration whose live subscription was minted under `keyed`. */
function registration(keyed: string): unknown {
  return {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue({
        options: { applicationServerKey: vapidBytes(keyed) },
        toJSON: () => ({ endpoint: ENDPOINT, keys: KEYS }),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
}

function core(vapid: string | null, pushers: unknown[] = []) {
  const commands: Commands = {
    webPusherSupport: vi.fn().mockResolvedValue(vapid),
    webPushers: vi.fn().mockResolvedValue(pushers),
    setPusher: vi.fn().mockResolvedValue(undefined),
    setWebPusher: vi.fn().mockResolvedValue(undefined),
    removePusher: vi.fn().mockResolvedValue(undefined),
  };
  commandsOf = commands;
  return {
    rpc: { push: commands },
    session: { account_id: 'account-a', user_id: '@me:example.org', device_id: 'LAPTOP' },
    deviceList: [],
  } as unknown as CoreClient;
}

let client: CoreClient;
let commandsOf: Commands;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('Notification', { permission: 'granted' });
  localStorage.clear();
  mocks.deliversWebPush.mockReturnValue(true);
  mocks.activeServiceWorker.mockResolvedValue(registration(shipped.vapid));
  mocks.runtimeConfig.mockResolvedValue({ push: SYGNAL });
  client = core(SERVER_KEY);
});

test('a web push capability has the homeserver deliver, not the gateway', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));

  await syncPushSubscription(client, NONE);

  expect(commandsOf.setWebPusher).toHaveBeenCalledWith({
    pusher: expect.objectContaining({ pushkey: 'keys-p256dh', app_id: WEBPUSH_APP_ID }) as unknown,
  });
  expect(commandsOf.setPusher).not.toHaveBeenCalled();
});

test('logout unregisters only the current native account before ending its session', async () => {
  mocks.deliversWebPush.mockReturnValue(false);
  const logout = vi.fn().mockResolvedValue(undefined);
  const session = client.session;
  const signedIn = Object.assign(client, {
    accounts: [session, { user_id: '@other:example.org', device_id: 'OTHER' }],
    logout,
  });

  await logoutWithPush(signedIn, NONE);

  expect(mocks.unregisterNativePush).toHaveBeenCalledWith(session);
  expect(mocks.forgetPushSession).toHaveBeenCalledWith('@me:example.org');
  expect(mocks.unregisterNativePush.mock.invocationCallOrder[0]).toBeLessThan(
    logout.mock.invocationCallOrder[0]
  );
  expect(logout).toHaveBeenCalledOnce();
});

test('logout without a current session never unregisters every native account', async () => {
  mocks.deliversWebPush.mockReturnValue(false);
  const logout = vi.fn().mockResolvedValue(undefined);
  const signedOut = Object.assign(client, {
    session: null,
    accounts: [{ user_id: '@other:example.org', device_id: 'OTHER' }],
    logout,
  });

  await logoutWithPush(signedOut, NONE);

  expect(mocks.unregisterNativePush).not.toHaveBeenCalled();
  expect(mocks.forgetPushSession).not.toHaveBeenCalled();
  expect(logout).toHaveBeenCalledOnce();
});

test('the account is noted before the homeserver sends its validation push', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));
  await syncPushSubscription(client, NONE);

  expect(mocks.expectPushActivation).toHaveBeenCalledWith('@me:example.org');
  const [expected] = mocks.expectPushActivation.mock.invocationCallOrder;
  const [registered] = commandsOf.setWebPusher.mock.invocationCallOrder;
  expect(expected).toBeLessThan(registered);
});

test('without a capability, the shipped gateway keeps collecting the pusher', async () => {
  client = core(null);

  await syncPushSubscription(client, NONE);

  expect(commandsOf.setPusher).toHaveBeenCalledWith({
    pusher: expect.objectContaining({ url: shipped.gateway, app_id: shipped.appId }) as unknown,
  });
  expect(commandsOf.setWebPusher).not.toHaveBeenCalled();
});

test('a complete override beats even a serving homeserver', async () => {
  await syncPushSubscription(client, {
    pushGatewayUrl: shipped.gateway,
    pushVapidKey: shipped.vapid,
    pushAppId: 'org.example.web',
  });

  expect(commandsOf.setPusher).toHaveBeenCalledWith({
    pusher: expect.objectContaining({ url: shipped.gateway, app_id: 'org.example.web' }) as unknown,
  });
  expect(commandsOf.setWebPusher).not.toHaveBeenCalled();
});

test('re-keying to the homeserver retires the gateway pusher under the old key', async () => {
  mocks.activeServiceWorker.mockResolvedValue({
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue({
        options: { applicationServerKey: vapidBytes(shipped.vapid) },
        toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'old-p256dh', auth: 'old-auth' } }),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
      }),
      subscribe: vi.fn().mockResolvedValue({
        options: { applicationServerKey: vapidBytes(SERVER_KEY) },
        toJSON: () => ({ endpoint: ENDPOINT, keys: KEYS }),
      }),
    },
  });
  client = core(SERVER_KEY, [
    { pushkey: 'old-p256dh', app_id: shipped.appId, kind: 'http', activated: true },
  ]);

  await syncPushSubscription(client, NONE);

  expect(commandsOf.removePusher).toHaveBeenCalledWith({
    pushkey: 'old-p256dh',
    app_id: shipped.appId,
  });
  expect(commandsOf.setWebPusher).toHaveBeenCalledWith({
    pusher: expect.objectContaining({ pushkey: 'keys-p256dh', app_id: WEBPUSH_APP_ID }) as unknown,
  });
});

test('taking over the delivery retires the gateway pusher left behind', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));
  client = core(SERVER_KEY, [
    { pushkey: 'keys-p256dh', app_id: shipped.appId, kind: 'http', activated: true },
  ]);

  await syncPushSubscription(client, NONE);

  expect(commandsOf.removePusher).toHaveBeenCalledWith({
    pushkey: 'keys-p256dh',
    app_id: shipped.appId,
  });
  expect(commandsOf.setWebPusher).toHaveBeenCalledWith({
    pusher: expect.objectContaining({ pushkey: 'keys-p256dh', app_id: WEBPUSH_APP_ID }) as unknown,
  });
});

test('a server pusher left under the gateway app id is replaced', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));
  const legacy = { gateway: null, appId: shipped.appId, vapid: SERVER_KEY };
  writeText(
    'sable-push-endpoint',
    registrationMarker('account-a', ENDPOINT, legacy, false, 'Sable')
  );

  await syncPushSubscription(client, NONE);

  expect(commandsOf.removePusher).toHaveBeenCalledWith({
    pushkey: 'keys-p256dh',
    app_id: shipped.appId,
  });
  expect(commandsOf.setWebPusher).toHaveBeenCalledWith({
    pusher: expect.objectContaining({ pushkey: 'keys-p256dh', app_id: WEBPUSH_APP_ID }) as unknown,
  });
});

test('a missing server pusher is recreated even when the local marker matches', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));
  client = core(SERVER_KEY);
  await syncPushSubscription(client, NONE);
  commandsOf.setWebPusher.mockClear();

  await syncPushSubscription(client, NONE);

  expect(commandsOf.setWebPusher).toHaveBeenCalledOnce();
});

test('overlapping syncs register the homeserver pusher once', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));

  await Promise.all([syncPushSubscription(client, NONE), syncPushSubscription(client, NONE)]);

  expect(commandsOf.setWebPusher).toHaveBeenCalledOnce();
});

test('an unreadable pusher list leaves a pending registration alone', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));
  await syncPushSubscription(client, NONE);
  commandsOf.setWebPusher.mockClear();
  commandsOf.webPushers.mockRejectedValue(new Error('offline'));

  await expect(syncPushSubscription(client, NONE)).rejects.toThrow('offline');

  expect(commandsOf.setWebPusher).not.toHaveBeenCalled();
});

test('a browser without push has no push key, whatever its service worker holds', async () => {
  mocks.deliversWebPush.mockReturnValue(false);
  const getRegistration = vi.fn(() => Promise.resolve({}));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration },
  });

  await expect(currentPushKey()).resolves.toBeNull();
  expect(getRegistration).not.toHaveBeenCalled();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

test('uses the configured device name', () => {
  const session = { account_id: 'a', device_id: 'LAPTOP' };
  const own = (display_name: string | null) => ({ is_own: true, display_name });

  expect(pusherDisplayName({ session, deviceList: [] } as unknown as CoreClient)).toBe('Sable');
  expect(
    pusherDisplayName({ session, deviceList: [own('Work Firefox')] } as unknown as CoreClient)
  ).toBe('Work Firefox');
  expect(pusherDisplayName({ session, deviceList: [own('  ')] } as unknown as CoreClient)).toBe(
    'Sable'
  );
});

test('updates the pusher after a device rename', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));
  await syncPushSubscription(client, NONE);
  expect(commandsOf.setWebPusher).toHaveBeenLastCalledWith({
    pusher: expect.objectContaining({ device_display_name: 'Sable' }) as unknown,
  });

  Object.assign(client, { deviceList: [{ is_own: true, display_name: 'Work Firefox' }] });
  await syncPushSubscription(client, NONE);
  expect(commandsOf.setWebPusher).toHaveBeenLastCalledWith({
    pusher: expect.objectContaining({ device_display_name: 'Work Firefox' }) as unknown,
  });
});
