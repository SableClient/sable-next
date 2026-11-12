import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { roomView } from '#lib/test-support/room-views.js';

import { roomRow } from './nav-rows.js';

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return roomView({ room_id: roomId, ...overrides });
}

test('a room keeps the same row while its summary object is unchanged', () => {
  const summary = room('!a');

  expect(roomRow(summary)).toBe(roomRow(summary));
  expect(roomRow(summary)).toEqual({
    room: summary,
    roomId: '!a',
    depth: 0,
    kind: 'room',
    key: '!a',
  });
  expect(roomRow(room('!a'))).not.toBe(roomRow(summary));
});
