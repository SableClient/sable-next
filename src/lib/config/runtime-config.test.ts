import { expect, test } from 'vitest';

import { parseRuntimeConfig } from './runtime-config';

const details = {
  pushNotifyUrl: 'https://sygnal.example/_matrix/push/v1/notify',
  vapidPublicKey: 'key',
  webPushAppID: 'moe.sable.app.sygnal',
};

test('a full block is read, with the native app id optional', () => {
  expect(parseRuntimeConfig({ pushNotificationDetails: details }).push).toEqual({
    ...details,
    nativePushAppID: null,
  });

  expect(
    parseRuntimeConfig({
      pushNotificationDetails: { ...details, nativePushAppID: 'moe.sable.client.android' },
    }).push?.nativePushAppID
  ).toBe('moe.sable.client.android');
});

test('a block missing any of the three a subscription needs registers nothing', () => {
  for (const absent of ['pushNotifyUrl', 'vapidPublicKey', 'webPushAppID'] as const) {
    expect(
      parseRuntimeConfig({ pushNotificationDetails: { ...details, [absent]: '  ' } }).push
    ).toBeNull();

    const rest = Object.fromEntries(Object.entries(details).filter(([field]) => field !== absent));
    expect(parseRuntimeConfig({ pushNotificationDetails: rest }).push).toBeNull();
  }
});

test('a file a deployment broke leaves push unregistered rather than throwing', () => {
  for (const raw of [null, undefined, 'not an object', 42, {}, { pushNotificationDetails: 'no' }]) {
    expect(parseRuntimeConfig(raw).push).toBeNull();
  }
});

test('values are trimmed, so a stray newline does not reach the gateway check', () => {
  const parsed = parseRuntimeConfig({
    pushNotificationDetails: {
      ...details,
      pushNotifyUrl: ' https://sygnal.example/_matrix/push/v1/notify\n',
    },
  });

  expect(parsed.push?.pushNotifyUrl).toBe('https://sygnal.example/_matrix/push/v1/notify');
});
