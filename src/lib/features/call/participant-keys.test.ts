import { expect, test } from 'vitest';

import { byName, numberedName, participantKeys } from './participant-keys';

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

test('participants are listed by name, and a device keeps its number', () => {
  const names: Record<string, string> = { '@a:x': 'Zoe', '@b:x': 'adam' };
  const sorted = byName(['@a:x', '@c:x', '@b:x', '@a:x'], (userId) => names[userId]);

  expect(sorted).toEqual(['@c:x', '@b:x', '@a:x', '@a:x']);
  expect(participantKeys(sorted)).toEqual(['@c:x', '@b:x', '@a:x', '@a:x#1']);
});
