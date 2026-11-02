import { expect, test } from 'vitest';

import { offersCall } from './room-call-support.svelte.js';

const room = { direct: false, participants: 0, members: 0, alwaysShow: false };

test('a room whose members are still loading offers no call', () => {
  expect(offersCall(room)).toBe(false);
});

test('a small, direct, active or always-offered room offers a call', () => {
  expect(offersCall({ ...room, members: 4 })).toBe(true);
  expect(offersCall({ ...room, direct: true })).toBe(true);
  expect(offersCall({ ...room, participants: 1 })).toBe(true);
  expect(offersCall({ ...room, alwaysShow: true })).toBe(true);
});

test('a large room offers no call', () => {
  expect(offersCall({ ...room, members: 11 })).toBe(false);
});
