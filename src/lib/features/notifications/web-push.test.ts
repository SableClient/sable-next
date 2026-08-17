// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { needsRegistering, vapidBytes } from './web-push';

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
  expect(needsRegistering('https://push.example/a', null)).toBe(true);
  expect(needsRegistering('https://push.example/a', 'https://push.example/b')).toBe(true);
  expect(needsRegistering('https://push.example/a', 'https://push.example/a')).toBe(false);
});
