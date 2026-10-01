// @vitest-environment happy-dom
import { afterEach, expect, test } from 'vitest';
import { readV1Sessions, v1CryptoPrefixes } from './migration.js';

const account = {
  baseUrl: 'https://example.org',
  userId: '@one:example.org',
  deviceId: 'ONE',
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  oidc: { issuer: 'https://issuer.example.org', clientId: 'original-client' },
};

afterEach(() => {
  localStorage.clear();
});

test('preserves multiple sessions and OAuth registration, with both device and shared prefixes', () => {
  const other = { ...account, userId: '@two:example.org', deviceId: 'TWO' };
  localStorage.setItem('matrixSessions', JSON.stringify([account, other, account]));
  expect(readV1Sessions(localStorage)).toEqual([account, other]);
  expect(v1CryptoPrefixes(account)).toEqual(['sync@one:example.org:ONE', 'sync@one:example.org']);
});

test('old Cinny credentials use the original SDK prefixes and remain untouched', () => {
  const entries = {
    cinny_hs_base_url: account.baseUrl,
    cinny_user_id: account.userId,
    cinny_device_id: account.deviceId,
    cinny_access_token: account.accessToken,
  };
  for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  const saved = readV1Sessions(localStorage);
  expect(saved[0]).toMatchObject({
    baseUrl: account.baseUrl,
    userId: account.userId,
    deviceId: account.deviceId,
    accessToken: account.accessToken,
    fallbackSdkStores: true,
  });
  expect(v1CryptoPrefixes(saved[0])).toEqual(['matrix-js-sdk:ONE', 'matrix-js-sdk']);
  for (const [key, value] of Object.entries(entries)) expect(localStorage.getItem(key)).toBe(value);
});

test('malformed source errors never quote credential JSON', () => {
  localStorage.setItem('matrixSessions', '{"accessToken":"very-secret-token"');
  expect(() => readV1Sessions(localStorage)).toThrow(
    'The v1 account list is invalid; its data has been kept'
  );
  expect(localStorage.getItem('matrixSessions')).toContain('very-secret-token');
  localStorage.setItem('matrixSessions', JSON.stringify([{ ...account, deviceId: '' }]));
  expect(() => readV1Sessions(localStorage)).toThrow('A v1 account is incomplete');
});

test('invalid homeserver and OAuth issuer URLs are rejected', () => {
  for (const source of [
    { ...account, baseUrl: 'javascript:bad' },
    { ...account, oidc: { ...account.oidc, issuer: 'http://issuer.example.org' } },
  ]) {
    localStorage.setItem('matrixSessions', JSON.stringify([source]));
    expect(() => readV1Sessions(localStorage)).toThrow(/Invalid v1/);
  }
});
