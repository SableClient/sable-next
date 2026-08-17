// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import type { PushConfig } from './push-config';
import { needsRegistering, registrationMarker, vapidBytes } from './web-push';

const shipped: PushConfig = {
  gateway: 'https://sygnal.sable.moe/_matrix/push/v1/notify',
  appId: 'moe.sable.app.sygnal',
  vapid: 'shipped-key',
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
  const first = registrationMarker('https://push.example/a', shipped);
  const second = registrationMarker('https://push.example/b', shipped);

  expect(needsRegistering(first, null)).toBe(true);
  expect(needsRegistering(first, second)).toBe(true);
  expect(needsRegistering(first, first)).toBe(false);
});

test('retargeting the gateway re-registers though the endpoint is unchanged', () => {
  const endpoint = 'https://push.example/a';
  const mine: PushConfig = {
    gateway: 'https://mine.example/_matrix/push/v1/notify',
    appId: 'org.example.web',
    vapid: 'my-key',
  };

  const before = registrationMarker(endpoint, shipped);
  expect(needsRegistering(registrationMarker(endpoint, mine), before)).toBe(true);
});
