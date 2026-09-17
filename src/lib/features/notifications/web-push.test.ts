// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

const mocks = vi.hoisted(() => ({
  deliversWebPush: vi.fn<() => boolean>(),
  activeServiceWorker: vi.fn<() => Promise<unknown>>(),
  runtimeConfig: vi.fn<() => Promise<{ push: unknown }>>(),
}));

vi.mock('#lib/platform/notifications.js', () => ({
  deliversWebPush: mocks.deliversWebPush,
}));
vi.mock('#lib/platform/service-worker.js', () => ({
  activeServiceWorker: mocks.activeServiceWorker,
}));
vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: mocks.runtimeConfig,
}));
vi.mock('#lib/settings/preferences.svelte.js', () => ({
  preferences: { richPushPayloads: true },
}));

import {
  applicationServerKeyMatches,
  needsRegistering,
  registrationMarker,
  syncPushSubscription,
  vapidBytes,
} from './web-push';

const shipped = {
  gateway: 'https://sygnal.sable.moe/_matrix/push/v1/notify',
  appId: 'moe.sable.app.sygnal',
  vapid: 'cd2ON9yidLJ-CC_AmKKNgcTpgsHiueDBxPmyBZFTfik',
};

const server = {
  gateway: null,
  appId: 'moe.sable.app.sygnal',
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
    webPusherSupport: vi.fn().mockResolvedValue({ vapid }),
    webPushers: vi.fn().mockResolvedValue(pushers),
    setPusher: vi.fn().mockResolvedValue(undefined),
    setWebPusher: vi.fn().mockResolvedValue(undefined),
    removePusher: vi.fn().mockResolvedValue(undefined),
  };
  commandsOf = commands;
  return { commands, session: { account_id: 'account-a' } } as unknown as CoreClient;
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

  expect(commandsOf.setWebPusher).toHaveBeenCalledWith(
    expect.objectContaining({ pushkey: 'keys-p256dh', app_id: shipped.appId })
  );
  expect(commandsOf.setPusher).not.toHaveBeenCalled();
});

test('without a capability, the shipped gateway keeps collecting the pusher', async () => {
  client = core(null);

  await syncPushSubscription(client, NONE);

  expect(commandsOf.setPusher).toHaveBeenCalledWith(
    expect.objectContaining({ url: shipped.gateway, app_id: shipped.appId })
  );
  expect(commandsOf.setWebPusher).not.toHaveBeenCalled();
});

test('a complete override beats even a serving homeserver', async () => {
  await syncPushSubscription(client, {
    pushGatewayUrl: shipped.gateway,
    pushVapidKey: shipped.vapid,
    pushAppId: 'org.example.web',
  });

  expect(commandsOf.setPusher).toHaveBeenCalledWith(
    expect.objectContaining({ url: shipped.gateway, app_id: 'org.example.web' })
  );
  expect(commandsOf.setWebPusher).not.toHaveBeenCalled();
});

test('taking over the delivery retires the gateway pusher left behind', async () => {
  mocks.activeServiceWorker.mockResolvedValue(registration(SERVER_KEY));
  client = core(SERVER_KEY, [
    { pushkey: 'keys-p256dh', app_id: shipped.appId, kind: 'http', activated: true },
  ]);

  await syncPushSubscription(client, NONE);

  expect(commandsOf.removePusher).toHaveBeenCalledWith('keys-p256dh', shipped.appId);
  expect(commandsOf.setWebPusher).toHaveBeenCalledWith(
    expect.objectContaining({ pushkey: 'keys-p256dh', app_id: shipped.appId })
  );
});
