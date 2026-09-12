import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomSummary } from '#src/generated/protocol';

import { RoomList } from './room-list.svelte.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubLocalStorage(): Map<string, string> {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => {
      stored.delete(key);
    },
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  });
  return stored;
}

test('resolves notification modes for the whole list in one command', async () => {
  const roomNotificationModes = vi.fn((roomIds: readonly string[]) =>
    Promise.resolve(
      roomIds.map((room_id) => ({
        room_id,
        room: room_id.startsWith('!room-1') ? ('mute' as const) : null,
        default: 'all' as const,
      }))
    )
  );
  const rooms = Array.from({ length: 20 }, (_, index) => ({
    room_id: `!room-${String(index)}:example.org`,
  })) as RoomSummary[];
  const core = {
    subscribeEvents: vi.fn(() => {
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms })),
      roomNotificationModes,
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  await vi.waitFor(() => {
    expect(roomList.mutedRoomIds.size).toBe(11);
  });

  expect(roomNotificationModes).toHaveBeenCalledTimes(1);
  expect(roomNotificationModes.mock.calls[0]?.[0]).toHaveLength(20);
  roomList.stop();
});

test('clears a room avatar when a room-list diff supplies null', async () => {
  const room = {
    room_id: '!room:example.org',
    avatar_url: 'mxc://example.org/avatar',
  } as RoomSummary;
  const clearedRoom = { ...room, avatar_url: null };
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
      roomNotificationModes: vi.fn(() => Promise.resolve([])),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  eventListeners[0]?.({
    type: 'room_list_diff',
    subscription: 1,
    diffs: [{ op: 'set', index: 0, value: clearedRoom }],
  });

  expect(roomList.rooms[0]?.avatar_url).toBeNull();
  roomList.stop();
});

test('holds the typing user ids so a room opened later reads them', async () => {
  const room = { room_id: '!room:example.org' } as RoomSummary;
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
      roomNotificationModes: vi.fn(() => Promise.resolve([])),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  for (const listener of eventListeners) {
    listener({ type: 'typing', room_id: room.room_id, user_ids: ['@alice:example.org'] });
  }

  expect(roomList.typingUserIds(room.room_id)).toEqual(['@alice:example.org']);
  expect(roomList.typingUserIds('!other:example.org')).toEqual([]);

  for (const listener of eventListeners) {
    listener({ type: 'typing', room_id: room.room_id, user_ids: [] });
  }

  expect(roomList.typingUserIds(room.room_id)).toEqual([]);
  roomList.stop();
});

test('paints the persisted room list before the subscription answers', async () => {
  const room = { room_id: '!persisted:example.org', name: 'Persisted' } as RoomSummary;
  stubLocalStorage().set('sable.room-list.acct', JSON.stringify([room]));
  let resolveSubscription: (value: {
    subscription: number;
    rooms: RoomSummary[];
  }) => void = () => {};
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(
        () =>
          new Promise<{ subscription: number; rooms: RoomSummary[] }>((resolve) => {
            resolveSubscription = resolve;
          })
      ),
      roomNotificationModes: vi.fn(() => Promise.resolve([])),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  const started = roomList.start();
  expect(roomList.rooms).toEqual([room]);

  resolveSubscription({ subscription: 1, rooms: [] });
  await started;
  expect(roomList.rooms).toEqual([room]);

  roomList.stop();
});

test('persists the live room list for the next launch', async () => {
  vi.useFakeTimers();
  const stored = stubLocalStorage();
  const room = { room_id: '!live:example.org', name: 'Live' } as RoomSummary;
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
      roomNotificationModes: vi.fn(() => Promise.resolve([])),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  expect(stored.has('sable.room-list.acct')).toBe(false);
  vi.advanceTimersByTime(1_000);
  expect(JSON.parse(stored.get('sable.room-list.acct') ?? '[]')).toEqual([room]);

  roomList.stop();
  vi.useRealTimers();
});
