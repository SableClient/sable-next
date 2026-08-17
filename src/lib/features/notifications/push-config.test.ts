import { expect, test } from 'vitest';

import type { PushDetails } from '$lib/config/runtime-config';

import {
  hasCompleteOverride,
  hasPartialOverride,
  overrideProblem,
  type PushOverride,
  resolvePushConfig,
} from './push-config';

const details: PushDetails = {
  pushNotifyUrl: 'https://sygnal.sable.moe/_matrix/push/v1/notify',
  vapidPublicKey: 'shipped-key',
  webPushAppID: 'moe.sable.app.sygnal',
  nativePushAppID: 'moe.sable.client.android',
};

const NONE: PushOverride = { pushGatewayUrl: '', pushVapidKey: '', pushAppId: '' };

const COMPLETE: PushOverride = {
  pushGatewayUrl: 'https://mine.example/_matrix/push/v1/notify',
  pushVapidKey: 'my-key',
  pushAppId: 'org.example.web',
};

test("the deployment's config is what registers when nothing is overridden", () => {
  expect(resolvePushConfig(NONE, details)).toEqual({
    gateway: 'https://sygnal.sable.moe/_matrix/push/v1/notify',
    appId: 'moe.sable.app.sygnal',
    vapid: 'shipped-key',
  });
});

test('an override takes over only once all three of its fields are filled', () => {
  expect(hasCompleteOverride(COMPLETE)).toBe(true);
  expect(resolvePushConfig(COMPLETE, details)).toEqual({
    gateway: 'https://mine.example/_matrix/push/v1/notify',
    appId: 'org.example.web',
    vapid: 'my-key',
  });

  for (const key of ['pushGatewayUrl', 'pushVapidKey', 'pushAppId'] as const) {
    for (const blank of ['', '   ']) {
      const partial = { ...COMPLETE, [key]: blank };
      expect(hasCompleteOverride(partial)).toBe(false);
      expect(resolvePushConfig(partial, details)).toEqual(resolvePushConfig(NONE, details));
    }
  }
});

test('a part-filled override is called out, an empty or complete one is not', () => {
  expect(hasPartialOverride(NONE)).toBe(false);
  expect(hasPartialOverride(COMPLETE)).toBe(false);

  for (const key of ['pushGatewayUrl', 'pushVapidKey', 'pushAppId'] as const) {
    expect(hasPartialOverride({ ...NONE, [key]: 'something' })).toBe(true);
    expect(hasPartialOverride({ ...COMPLETE, [key]: '' })).toBe(true);
    expect(hasPartialOverride({ ...NONE, [key]: '   ' })).toBe(false);
  }
});

test('a complete override still works where the deployment shipped no default', () => {
  expect(resolvePushConfig(COMPLETE, null)?.gateway).toBe(
    'https://mine.example/_matrix/push/v1/notify'
  );
  expect(resolvePushConfig(NONE, null)).toBeNull();
});

test('an override is only accepted for an address the core would also accept', () => {
  expect(overrideProblem(NONE)).toBeNull();
  expect(overrideProblem(COMPLETE)).toBeNull();
  expect(overrideProblem({ ...COMPLETE, pushGatewayUrl: '' })).toBe('incomplete');
  expect(overrideProblem({ ...COMPLETE, pushGatewayUrl: 'not a url' })).toBe('notAUrl');

  // The same rejections `gateway()` makes in crates/sable-core/src/notifications.rs.
  const rejected = [
    'http://sygnal.example/_matrix/push/v1/notify',
    'https://user:pass@sygnal.example/_matrix/push/v1/notify',
    'https://sygnal.example/_matrix/push/v1/notify#fragment',
    'https://sygnal.example/',
    'https://sygnal.example/_matrix/push/v1/notify/extra',
  ];
  for (const pushGatewayUrl of rejected) {
    expect(overrideProblem({ ...COMPLETE, pushGatewayUrl })).toBe('notAGateway');
  }
});

test('surrounding whitespace never reaches the gateway check', () => {
  const padded = resolvePushConfig(
    {
      pushGatewayUrl: '  https://mine.example/_matrix/push/v1/notify  ',
      pushVapidKey: ' my-key ',
      pushAppId: ' org.example.web ',
    },
    details
  );

  expect(padded).toEqual(resolvePushConfig(COMPLETE, details));
});
