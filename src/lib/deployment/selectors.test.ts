import { expect, test } from 'vitest';

import { parseRuntimeConfig } from '#lib/config/runtime-config.js';

import { appName, pageTitle } from './brand.js';
import {
  communityFeatures,
  donateUrl,
  privacyUrl,
  SABLE_PRIVACY_URL,
  sourceUrl,
  supportRoom,
} from './links.js';
import { deviceDisplayName, registrationEnabled } from './policy.js';

const sable = parseRuntimeConfig({});
const acme = parseRuntimeConfig({
  branding: { appName: 'Acme' },
  links: { privacy: 'https://acme.example/privacy', supportRoom: '#help:acme.example' },
  hideCommunityLinks: true,
  auth: { disableRegistration: true },
});

test('an unbranded deployment is Sable', () => {
  expect(appName(sable)).toBe('Sable');
  expect(pageTitle('Settings', sable)).toBe('Settings - Sable');
  expect(pageTitle('', sable)).toBe('Sable');
  expect(deviceDisplayName(sable)).toBe('Sable');
  expect(privacyUrl(sable)).toBe(SABLE_PRIVACY_URL);
  expect(registrationEnabled(sable)).toBe(true);
});

test('a branded deployment names itself everywhere', () => {
  expect(pageTitle('Settings', acme)).toBe('Settings - Acme');
  expect(pageTitle('Acme', acme)).toBe('Acme');
  expect(deviceDisplayName(acme)).toBe('Acme');
  expect(privacyUrl(acme)).toBe('https://acme.example/privacy');
  expect(registrationEnabled(acme)).toBe(false);
});

test('hiding community links keeps the deployment support room', () => {
  expect(communityFeatures(acme)).toBe(false);
  expect(communityFeatures(sable)).toBe(true);
  expect(sourceUrl(acme)).toBeNull();
  expect(donateUrl(acme)).toBeNull();
  expect(supportRoom(acme)).toBe('#help:acme.example');
  expect(supportRoom(parseRuntimeConfig({ hideCommunityLinks: true }))).toBeNull();
});
