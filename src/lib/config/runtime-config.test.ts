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

test('a file a deployment broke leaves push unregistered without throwing', () => {
  for (const raw of [null, undefined, 'not an object', 42, {}, { pushNotificationDetails: 'no' }]) {
    expect(parseRuntimeConfig(raw).push).toBeNull();
  }
});

test('a gifs block is read on its own, so a broken push block does not hide it', () => {
  const parsed = parseRuntimeConfig({
    pushNotificationDetails: 'no',
    gifs: { provider: 'giphy', proxyUrl: ' gifs.example ', giphyApiKey: 'key' },
  });

  expect(parsed.push).toBeNull();
  expect(parsed.gifs).toEqual({
    provider: 'giphy',
    proxyUrl: 'gifs.example',
    klipyApiKey: null,
    tenorApiKey: null,
    giphyApiKey: 'key',
  });
});

test('a provider name the client does not know falls back to the built-in default', () => {
  for (const provider of ['gfycat', 42, '', null]) {
    expect(parseRuntimeConfig({ gifs: { provider } }).gifs.provider).toBeNull();
  }
});

test('a file with no gifs block leaves every gif field unset', () => {
  for (const raw of [null, {}, { gifs: 'no' }]) {
    expect(parseRuntimeConfig(raw).gifs).toEqual({
      provider: null,
      proxyUrl: null,
      klipyApiKey: null,
      tenorApiKey: null,
      giphyApiKey: null,
    });
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
