import { expect, test, vi } from 'vitest';

import type { RoomListItemView, RpcParams, Rpc } from '#src/generated/protocol';

import { claimedRoomIds, isActiveSpace, markRoomUnread, markRoomsRead } from './nav-rooms.js';

function room(overrides: Partial<RoomListItemView>): RoomListItemView {
  return {
    room_id: '!r',
    is_direct: false,
    direct_targets: [],
    state: 'joined',
    is_tombstoned: false,
    space_children: [],
    unread: 0,
    highlight: 0,
    latest_event: null,
    ...overrides,
  } as unknown as RoomListItemView;
}

test('only joined spaces claim their children', () => {
  const claimed = claimedRoomIds([
    room({
      room_id: '!joined',
      room_kind: 'space',
      space_children: [
        { room_id: '!child', via: ['example.org'] },
      ] as RoomListItemView['space_children'],
    }),
    room({
      room_id: '!invited',
      room_kind: 'space',
      state: 'invited',
      space_children: [
        { room_id: '!other', via: ['example.org'] },
      ] as RoomListItemView['space_children'],
    }),
    room({
      room_id: '!tombstoned',
      room_kind: 'space',
      is_tombstoned: true,
      space_children: [
        { room_id: '!replaced', via: ['example.org'] },
      ] as RoomListItemView['space_children'],
    }),
    room({ room_id: '!plain' }),
  ]);

  expect([...claimed]).toEqual(['!child']);
});

test('a child removed from its space is not claimed', () => {
  const claimed = claimedRoomIds([
    room({
      room_id: '!space',
      room_kind: 'space',
      space_children: [
        { room_id: '!removed', via: [], order: null, origin_server_ts: 0, suggested: false },
      ],
    }),
  ]);

  expect(claimed.size).toBe(0);
});

test('tombstoned spaces are not active sidebar spaces', () => {
  expect(isActiveSpace(room({ room_kind: 'space', state: 'joined', is_tombstoned: true }))).toBe(
    false
  );
  expect(isActiveSpace(room({ room_kind: 'space', state: 'joined', is_tombstoned: false }))).toBe(
    true
  );
});

test('marks only rooms that are actually unread', () => {
  const markRead = vi.fn(() => Promise.resolve(null));

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
    [
      {
        room_id: '!unread',
        event_id: null,
        thread_root: null,
        subscription: null,
        fully_read: true,
      },
    ],
    [
      {
        room_id: '!highlighted',
        event_id: null,
        thread_root: null,
        subscription: null,
        fully_read: true,
      },
    ],
  ]);
});

test('marks a room unread without moving its read marker', () => {
  const markUnread = vi.fn(() => Promise.resolve(null));

  markRoomUnread('!room:example.org', { markUnread });

  expect(markUnread).toHaveBeenCalledWith({ room_id: '!room:example.org', read_marker: null });
});

test('a failed mark does not stop the rest', () => {
  const markRead = vi
    .fn<(params: RpcParams<Rpc['timeline']['markRead']>) => Promise<null>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(null);

  markRoomsRead(
    [
      room({ room_id: '!a', unread: 1, latest_event: { event_id: '$a' } as never }),
      room({ room_id: '!b', unread: 1, latest_event: { event_id: '$b' } as never }),
    ],
    { markRead }
  );

  expect(markRead).toHaveBeenCalledTimes(2);
});
