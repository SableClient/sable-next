import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { roomRow } from './nav-rows.js';

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return {
    room_id: roomId,
    tags: [],
    latest_event: null,
    ...overrides,
  } as unknown as RoomListItemView;
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
