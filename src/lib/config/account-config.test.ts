import { expect, test } from 'vitest';
import { accountConfigUrl, mergeAccountConfig, parseAccountConfig } from './account-config.js';
import { parseRuntimeConfig } from './runtime-config.js';

test('uses the Matrix domain origin, preserving ports', () => {
  expect(accountConfigUrl('example.org:8448')).toBe('https://example.org:8448/.well-known/sable');
  expect(accountConfigUrl('https://example.org/api/')).toBe(
    'https://example.org/.well-known/sable'
  );
  expect(accountConfigUrl('http://example.org')).toBeNull();
  expect(accountConfigUrl('https://user:pass@example.org')).toBeNull();
});

test('filters account fields and resolves asset URLs', () => {
  expect(
    parseAccountConfig(
      {
        branding: { logoUrl: '/logo.svg', themeUrl: 'theme.json' },
        settingsLocked: {
          hour24Clock: true,
          pushGatewayUrl: 'https://push.example.org',
          updateChannel: 'nightly',
        },
        disableAccountSwitcher: true,
        pushNotificationDetails: {},
      },
      'https://example.org/.well-known/sable'
    )
  ).toEqual({
    branding: {
      logoUrl: 'https://example.org/logo.svg',
      themeUrl: 'https://example.org/.well-known/theme.json',
    },
    settingsLocked: { hour24Clock: true },
  });
});

test('preserves omitted fields and accepts false overrides', () => {
  const base = parseRuntimeConfig({
    branding: { appName: 'Local' },
    hideCommunityLinks: true,
    auth: { disableRegistration: true },
    settingsLocked: { urlPreviews: false },
  });
  const account = parseAccountConfig(
    {
      branding: { appName: 42 },
      hideCommunityLinks: false,
      auth: { disableRegistration: false },
      settingsLocked: { urlPreviews: true },
    },
    'https://example.org/.well-known/sable'
  );
  const merged = mergeAccountConfig(base, account);
  expect(merged.branding.appName).toBe('Local');
  expect(merged.hideCommunityLinks).toBe(false);
  expect(merged.auth.disableRegistration).toBe(true);
  expect(merged.settingsLocked.urlPreviews).toBe(false);
  expect(parseAccountConfig([], 'https://example.org')).toBeNull();
});
