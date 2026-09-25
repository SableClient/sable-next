import { expect, test } from 'vitest';

import { participantKeys } from './participant-keys';

test('a user on two devices gets a key per device', () => {
  expect(participantKeys(['@a:x', '@b:x', '@a:x', '@a:x'])).toEqual([
    '@a:x',
    '@b:x',
    '@a:x#1',
    '@a:x#2',
  ]);
});
