import { expect, test } from 'vitest';

import { callServiceUrl } from './call-service-url';

test.each([
  [' https://rtc.example.org ', 'https://rtc.example.org/'],
  ['https://rtc.example.org/livekit/jwt', 'https://rtc.example.org/livekit/jwt'],
  ['http://localhost:8080', 'http://localhost:8080/'],
  ['http://[::1]:8080/rtc', 'http://[::1]:8080/rtc'],
])('accepts and normalizes %s', (input, expected) => {
  expect(callServiceUrl(input)).toBe(expected);
});

test.each([
  '',
  '   ',
  'rtc.example.org',
  '/livekit/jwt',
  'javascript:alert(1)',
  'wss://rtc.example.org',
  'https://user:password@rtc.example.org',
  'https://rtc.example.org?token=secret',
  'https://rtc.example.org#settings',
  'https://rtc.example.org?',
  'https://rtc.example.org#',
])('rejects an unusable service URL: %s', (input) => {
  expect(callServiceUrl(input)).toBeNull();
});
