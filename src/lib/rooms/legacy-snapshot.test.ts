// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { forgetLegacyRoomListSnapshots } from './legacy-snapshot.js';

afterEach(() => {
  localStorage.clear();
});

test('drops the room list copies of every account and leaves other keys alone', () => {
  localStorage.setItem('sable.room-list.a1', '[]');
  localStorage.setItem('sable.room-list.a2', '[]');
  localStorage.setItem('sable-quiet-rooms', '[]');

  forgetLegacyRoomListSnapshots();

  expect(Object.keys(localStorage)).toEqual(['sable-quiet-rooms']);
});
