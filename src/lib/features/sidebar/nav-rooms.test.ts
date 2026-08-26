import { expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';

import { claimedRoomIds, markRoomsRead } from './nav-rooms.js';

function room(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    room_id: '!r',
    is_space: false,
    is_direct: false,
    state: 'joined',
    space_children: [],
    unread: 0,
    highlight: 0,
    latest_event: null,
    ...overrides,
  } as unknown as RoomSummary;
}

test('only joined spaces claim their children', () => {
  const claimed = claimedRoomIds([
    room({
      room_id: '!joined',
      is_space: true,
      space_children: [{ room_id: '!child' }] as RoomSummary['space_children'],
    }),
    room({
      room_id: '!invited',
      is_space: true,
      state: 'invited',
      space_children: [{ room_id: '!other' }] as RoomSummary['space_children'],
    }),
    room({ room_id: '!plain' }),
  ]);

  expect([...claimed]).toEqual(['!child']);
});

test('marks only rooms that are actually unread', () => {
  const markRead = vi.fn(() => Promise.resolve());

  markRoomsRead(
    [
      room({ room_id: '!unread', unread: 3, latest_event: { event_id: '$a' } as never }),
      room({ room_id: '!highlighted', highlight: 1, latest_event: { event_id: '$b' } as never }),
      room({ room_id: '!read', latest_event: { event_id: '$c' } as never }),
      room({ room_id: '!empty', unread: 2, latest_event: null }),
      null,
    ],
    { markRead }
  );

  expect(markRead.mock.calls).toEqual([
    ['!unread', '$a'],
    ['!highlighted', '$b'],
  ]);
});

test('a failed mark does not stop the rest', () => {
  const markRead = vi
    .fn<(roomId: string, eventId: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce();

  markRoomsRead(
    [
      room({ room_id: '!a', unread: 1, latest_event: { event_id: '$a' } as never }),
      room({ room_id: '!b', unread: 1, latest_event: { event_id: '$b' } as never }),
    ],
    { markRead }
  );

  expect(markRead).toHaveBeenCalledTimes(2);
});
