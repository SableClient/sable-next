import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomSummary } from '#src/generated/protocol';

import { countNotifications, notifications } from '#lib/features/inbox/inbox.js';

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
    expect(
      rooms.filter((entry) => roomList.notificationMode(entry.room_id) === 'mute')
    ).toHaveLength(11);
  });

  expect(roomNotificationModes).toHaveBeenCalledTimes(1);
  expect(roomNotificationModes.mock.calls[0]?.[0]).toHaveLength(20);
  expect(roomList.notificationMode('!room-0:example.org')).toBe('all');
  expect(roomList.notificationMode('!room-1:example.org')).toBe('mute');
  roomList.stop();
});

test('a room override set here shows before the push rules echo back', async () => {
  const rooms = [{ room_id: '!room:example.org' }] as RoomSummary[];
  const core = {
    subscribeEvents: vi.fn(() => {
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms })),
      roomNotificationModes: vi.fn(() =>
        Promise.resolve([{ room_id: '!room:example.org', room: null, default: 'all' as const }])
      ),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  await vi.waitFor(() => {
    expect(roomList.notificationMode('!room:example.org')).toBe('all');
  });

  roomList.setNotificationOverride('!room:example.org', 'mentions');
  expect(roomList.notificationOverride('!room:example.org')).toBe('mentions');
  expect(roomList.notificationMode('!room:example.org')).toBe('mentions');

  roomList.setNotificationOverride('!room:example.org', null);
  expect(roomList.notificationMode('!room:example.org')).toBe('all');
  roomList.stop();
});

test('inbox counts follow room overrides and default changes', async () => {
  const rooms = [
    { room_id: '!inherited', state: 'joined', unread: 2, highlight: 0 },
    { room_id: '!override', state: 'joined', unread: 3, highlight: 0 },
  ] as RoomSummary[];
  let fallback = 'mentions' as 'all' | 'mentions';
  const listeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    },
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms }),
      roomNotificationModes: () =>
        Promise.resolve(
          rooms.map((room) => ({
            room_id: room.room_id,
            room: room.room_id === '!override' ? 'all' : null,
            default: fallback,
          }))
        ),
      unsubscribe: async () => {},
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);
  const mode = (roomId: string) => roomList.notificationMode(roomId);
  await roomList.start();
  await vi.waitFor(() => {
    expect(countNotifications(roomList.rooms, mode)).toBe(3);
  });
  expect(notifications(roomList.rooms, 'all', mode).map((room) => room.room_id)).toEqual([
    '!override',
  ]);

  fallback = 'all';
  for (const listener of listeners) listener({ type: 'notification_settings_changed' });
  await vi.waitFor(() => {
    expect(countNotifications(roomList.rooms, mode)).toBe(5);
  });
  expect(notifications(roomList.rooms, 'mentions', mode)).toEqual([]);
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

test('does not show cached unread counts before a room notification mode resolves', async () => {
  const stored = stubLocalStorage();
  const muted = {
    room_id: '!muted:example.org',
    unread: 4,
    highlight: 0,
    marked_unread: false,
  } as RoomSummary;
  stored.set('sable.room-list.acct', JSON.stringify([muted]));
  let resolveModes: (value: { room_id: string; room: 'mute'; default: 'all' }[]) => void = () => {};
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [muted] })),
      roomNotificationModes: vi.fn(
        () =>
          new Promise<{ room_id: string; room: 'mute'; default: 'all' }[]>((resolve) => {
            resolveModes = resolve;
          })
      ),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  expect(roomList.unreadFor(muted)).toEqual({
    unread: 0,
    highlight: 0,
    marked: false,
    notifying: 0,
  });
  expect(roomList.notificationsFor(muted)).toEqual({ unread: 0, highlight: 0, marked: false });

  resolveModes([{ room_id: muted.room_id, room: 'mute', default: 'all' }]);
  await vi.waitFor(() => {
    expect(roomList.notificationMode(muted.room_id)).toBe('mute');
  });
  expect(roomList.unreadFor(muted)).toEqual({
    unread: 0,
    highlight: 0,
    marked: false,
    notifying: 0,
  });
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

test('defers room-list snapshot writes until presentation resumes', async () => {
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

  roomList.setPresentationActive(false);
  await roomList.start();
  vi.advanceTimersByTime(1_000);
  expect(stored.has('sable.room-list.acct')).toBe(false);

  roomList.setPresentationActive(true);
  expect(JSON.parse(stored.get('sable.room-list.acct') ?? '[]')).toEqual([room]);

  roomList.stop();
  vi.useRealTimers();
});

test('a muted room that drops out of a reset and returns stays muted', async () => {
  const muted = {
    room_id: '!muted:example.org',
    unread: 4,
    highlight: 0,
    marked_unread: false,
  } as RoomSummary;
  const eventListeners: ((event: unknown) => void)[] = [];
  let reloads = 0;
  const roomNotificationModes = vi.fn(async (roomIds: readonly string[]) => {
    reloads += 1;
    if (reloads > 1) await new Promise(() => {});
    return roomIds.map((room_id) => ({ room_id, room: 'mute' as const, default: 'all' as const }));
  });
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [muted] })),
      roomNotificationModes,
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  await vi.waitFor(() => {
    expect(roomList.notificationMode(muted.room_id)).toBe('mute');
  });

  const reset = (rooms: RoomSummary[]): void => {
    eventListeners[0]?.({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'reset', values: rooms }],
    });
  };
  reset([]);
  reset([muted]);

  expect(roomList.notificationMode(muted.room_id)).toBe('mute');
  expect(roomList.unreadFor(muted)).toEqual({
    unread: 0,
    highlight: 0,
    marked: false,
    notifying: 0,
  });
  roomList.stop();
});

test('looks rooms up by id and labels them by name, then alias, then id', () => {
  const roomList = new RoomList({} as CoreClient);
  roomList.rooms = [
    { room_id: '!named:example.org', name: 'Named', canonical_alias: '#named:example.org' },
    { room_id: '!aliased:example.org', name: null, canonical_alias: '#aliased:example.org' },
    { room_id: '!bare:example.org', name: null, canonical_alias: null },
  ] as RoomSummary[];

  expect(roomList.byId('!aliased:example.org')).toBe(roomList.rooms[1]);
  expect(roomList.byId('!missing:example.org')).toBeUndefined();
  expect(roomList.byId(null)).toBeUndefined();
  expect(roomList.labelFor('!named:example.org')).toBe('Named');
  expect(roomList.labelFor('!aliased:example.org')).toBe('#aliased:example.org');
  expect(roomList.labelFor('!bare:example.org')).toBe('!bare:example.org');
  expect(roomList.labelFor('!missing:example.org')).toBe('!missing:example.org');

  roomList.rooms = [{ room_id: '!missing:example.org', name: 'Arrived' }] as RoomSummary[];
  expect(roomList.labelFor('!missing:example.org')).toBe('Arrived');
});
