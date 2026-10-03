import { expect, test } from 'vitest';

import { numberedName, participantKeys } from './participant-keys';

test('a user on two devices gets a key per device', () => {
  expect(participantKeys(['@a:x', '@b:x', '@a:x', '@a:x'])).toEqual([
    '@a:x',
    '@b:x',
    '@a:x#1',
    '@a:x#2',
  ]);
});

test('a second device is numbered in the name, the first is left alone', () => {
  expect(numberedName('Bob', '@bob:x')).toBe('Bob');
  expect(numberedName('Bob', '@bob:x#1')).toBe('Bob (2)');
  expect(numberedName('Bob', '@bob:x#2')).toBe('Bob (3)');
});
