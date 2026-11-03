import { expect, test } from 'vitest';

import { parseE2eePolicy } from './e2ee-policy.js';

const encryptedByDefault = { defaultEncrypted: true, forceDisabled: false };

test('nothing set keeps encryption on', () => {
  expect(parseE2eePolicy({})).toEqual(encryptedByDefault);
  expect(parseE2eePolicy({ 'm.homeserver': { base_url: 'https://hs.example' } })).toEqual(
    encryptedByDefault
  );
});

test('default false makes new rooms unencrypted without locking the choice', () => {
  expect(parseE2eePolicy({ 'io.element.e2ee': { default: false } })).toEqual({
    defaultEncrypted: false,
    forceDisabled: false,
  });
});

test('force_disable locks encryption off', () => {
  expect(parseE2eePolicy({ 'io.element.e2ee': { force_disable: true } })).toEqual({
    defaultEncrypted: true,
    forceDisabled: true,
  });
});

test('the deprecated alias applies when the current key is absent', () => {
  expect(parseE2eePolicy({ 'im.vector.riot.e2ee': { default: false } })).toEqual({
    defaultEncrypted: false,
    forceDisabled: false,
  });
});

test('io.element.e2ee wins over the alias', () => {
  expect(
    parseE2eePolicy({
      'io.element.e2ee': { default: true },
      'im.vector.riot.e2ee': { default: false, force_disable: true },
    })
  ).toEqual(encryptedByDefault);
});

test.each([
  null,
  undefined,
  'x',
  3,
  [],
  { 'io.element.e2ee': 'no' },
  { 'io.element.e2ee': { default: 'no' } },
])('malformed input %j means the default policy', (input) => {
  expect(parseE2eePolicy(input)).toEqual(encryptedByDefault);
});
