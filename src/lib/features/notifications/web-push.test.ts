// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import {
  applicationServerKeyMatches,
  needsRegistering,
  registrationMarker,
  vapidBytes,
} from './web-push';

const shipped = {
  gateway: 'https://sygnal.sable.moe/_matrix/push/v1/notify',
  appId: 'moe.sable.app.sygnal',
  vapid: 'shipped-key',
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
  expect(applicationServerKeyMatches(subscription, 'shipped-key')).toBe(false);

  const asBuffer = { options: { applicationServerKey: key.buffer } } as PushSubscription;
  expect(applicationServerKeyMatches(asBuffer, SERVER_KEY)).toBe(true);

  const bare = {} as PushSubscription;
  expect(applicationServerKeyMatches(bare, SERVER_KEY)).toBe(false);
});
