import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomSummary } from '#src/generated/protocol';

import { countNotifications, notifications } from '#lib/features/inbox/inbox.js';

import { setQuiet } from './quiet-rooms.svelte.js';
import { RoomList, roomPathId } from './room-list.svelte.js';
import { withCounts } from './summary-fixtures.js';

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

test("reads a room's mode off its summary", async () => {
  const rooms = [
    withCounts({
      room_id: '!muted:example.org',
      notification: { room: 'mute', default: 'all' },
    } as RoomSummary),
    withCounts({ room_id: '!plain:example.org', is_direct: false } as RoomSummary),
  ];
  const core = {
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms })),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();

  expect(roomList.notificationOverride('!muted:example.org')).toBe('mute');
  expect(roomList.notificationMode('!muted:example.org')).toBe('mute');
  expect(roomList.notificationOverride('!plain:example.org')).toBeNull();
  expect(roomList.notificationMode('!plain:example.org')).toBe('mentions');
  expect(roomList.notificationMode('!missing:example.org')).toBeNull();
  roomList.stop();
});

test('inbox counts follow badge defaults, and a mute silences it at once', async () => {
  const loud = withCounts({
    room_id: '!loud',
    state: 'joined',
    unread: 2,
    notifying: 2,
    highlight: 0,
    notification: { room: 'all', default: 'all' },
  } as RoomSummary);
  const quiet = withCounts({
    room_id: '!quiet',
    state: 'joined',
    unread: 3,
    notifying: 0,
    highlight: 0,
    notification: { room: null, default: 'all' },
  } as RoomSummary);
  const listeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    },
    commands: {
      subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [loud, quiet] }),
      unsubscribe: async () => {},
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);
  await roomList.start();
  expect(countNotifications(roomList.rooms, roomList.badgeUnreadFor)).toBe(2);
  expect(
    notifications(roomList.rooms, 'all', roomList.badgeUnreadFor).map((room) => room.room_id)
  ).toEqual(['!loud', '!quiet']);

  const muted = withCounts({ ...loud, notification: { room: 'mute', default: 'all' } });
  for (const listener of listeners) {
    listener({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'set', index: 0, value: muted }],
    });
  }
  expect(countNotifications(roomList.rooms, roomList.badgeUnreadFor)).toBe(0);
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
  const room = withCounts({
    room_id: '!persisted:example.org',
    name: 'Persisted',
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
  } as RoomSummary);
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

test('a snapshot from a build before resolved counts paints nothing', () => {
  stubLocalStorage().set(
    'sable.room-list.acct',
    JSON.stringify([{ room_id: '!old:example.org', unread: 4 }])
  );
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(() => new Promise(() => {})),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  void roomList.start();
  expect(roomList.rooms).toEqual([]);
  roomList.stop();
});

test('is not settled on a painted snapshot', async () => {
  const room = withCounts({ room_id: '!room:example.org' } as RoomSummary);
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
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  const started = roomList.start();
  expect(roomList.settled).toBe(false);

  resolveSubscription({ subscription: 1, rooms: [room] });
  await started;
  expect(roomList.settled).toBe(true);
  roomList.stop();
});

test('a diff after an empty first answer replaces the painted snapshot rather than joining it', async () => {
  const first = withCounts({ room_id: '!first:example.org' } as RoomSummary);
  const second = withCounts({ room_id: '!second:example.org' } as RoomSummary);
  stubLocalStorage().set('sable.room-list.acct', JSON.stringify([first, second]));
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [] })),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  expect(roomList.rooms.map((room) => room.room_id)).toEqual([first.room_id, second.room_id]);

  eventListeners[0]?.({
    type: 'room_list_diff',
    subscription: 1,
    diffs: [{ op: 'append', values: [first, second] }],
  });

  expect(roomList.rooms.map((room) => room.room_id)).toEqual([first.room_id, second.room_id]);
  roomList.stop();
});

test('waits for a room to be listed, and gives up after the timeout', async () => {
  const listed = { room_id: '!listed:example.org' } as RoomSummary;
  const late = { room_id: '!late:example.org' } as RoomSummary;
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [listed] })),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);
  await roomList.start();

  await roomList.whenListed(listed.room_id, 60_000);

  let arrived = false;
  const waiting = roomList.whenListed(late.room_id, 60_000).then(() => {
    arrived = true;
  });
  await Promise.resolve();
  expect(arrived).toBe(false);
  eventListeners[0]?.({
    type: 'room_list_diff',
    subscription: 1,
    diffs: [{ op: 'append', values: [late] }],
  });
  await waiting;

  vi.useFakeTimers();
  try {
    const missing = roomList.whenListed('!missing:example.org', 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await missing;
  } finally {
    vi.useRealTimers();
  }
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

test('a hidden room keeps its unread state and badges only its mentions', async () => {
  const quiet = withCounts({
    room_id: '!quiet:example.org',
    unread: 4,
    notifying: 4,
    highlight: 1,
    marked_unread: false,
    space_children: [],
    notification: { room: null, default: 'all' },
  } as unknown as RoomSummary);
  const core = {
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [quiet] })),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  setQuiet(quiet.room_id, true);

  expect(roomList.unreadFor(quiet)).toEqual({
    unread: 4,
    highlight: 1,
    marked: false,
    notifying: 4,
  });
  expect(roomList.badgeUnreadFor(quiet)).toEqual({
    unread: 1,
    highlight: 1,
    marked: false,
    notifying: 0,
  });

  setQuiet(quiet.room_id, false);
  roomList.stop();
});

test('badge defaults quiet group rooms while push stays all', async () => {
  const group = withCounts({
    room_id: '!group:example.org',
    is_direct: false,
    unread: 5,
    notifying: 5,
    highlight: 0,
    marked_unread: false,
    space_children: [],
    notification: { room: null, default: 'all' },
  } as unknown as RoomSummary);
  const dm = withCounts({
    room_id: '!dm:example.org',
    is_direct: true,
    unread: 3,
    notifying: 3,
    highlight: 0,
    marked_unread: false,
    space_children: [],
    notification: { room: null, default: 'all' },
  } as unknown as RoomSummary);
  const core = {
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [group, dm] })),
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();

  expect(roomList.badgeUnreadFor(group)).toEqual({
    unread: 5,
    highlight: 0,
    marked: false,
    notifying: 0,
  });
  expect(roomList.badgeUnreadFor(dm)).toEqual({
    unread: 3,
    highlight: 0,
    marked: false,
    notifying: 3,
  });

  roomList.stop();
});

test('warms each visible room once, batched into one command', () => {
  vi.useFakeTimers();
  const warmRooms = vi.fn(() => Promise.resolve());
  const roomList = new RoomList({ commands: { warmRooms } } as unknown as CoreClient);

  roomList.warm('!a:example.org');
  roomList.warm('!b:example.org');
  roomList.warm('!a:example.org');
  vi.advanceTimersByTime(100);
  roomList.warm('!b:example.org');
  vi.advanceTimersByTime(100);

  expect(warmRooms).toHaveBeenCalledTimes(1);
  expect(warmRooms).toHaveBeenCalledWith(['!a:example.org', '!b:example.org']);
  vi.useRealTimers();
});

test('stopping drops pending warms and forgets what was warmed', () => {
  vi.useFakeTimers();
  const warmRooms = vi.fn(() => Promise.resolve());
  const roomList = new RoomList({
    commands: { warmRooms, unsubscribe: vi.fn(() => Promise.resolve()) },
  } as unknown as CoreClient);

  roomList.warm('!a:example.org');
  roomList.stop();
  vi.advanceTimersByTime(100);
  expect(warmRooms).not.toHaveBeenCalled();

  roomList.warm('!a:example.org');
  vi.advanceTimersByTime(100);
  expect(warmRooms).toHaveBeenCalledWith(['!a:example.org']);
  vi.useRealTimers();
});

test('a room path uses its alias only when the room is the first live owner of it', () => {
  const room = (room_id: string, canonical_alias: string | null, is_tombstoned = false) =>
    ({ room_id, canonical_alias, is_tombstoned }) as RoomSummary;
  const old = room('!old:x', '#lounge:x', true);
  const lounge = room('!lounge:x', '#lounge:x');
  const copy = room('!copy:x', '#lounge:x');
  const plain = room('!plain:x', null);
  const rooms = [old, lounge, copy, plain];

  expect(roomPathId(lounge, rooms)).toBe('#lounge:x');
  expect(roomPathId(copy, rooms)).toBe('!copy:x');
  expect(roomPathId(old, rooms)).toBe('!old:x');
  expect(roomPathId(plain, rooms)).toBe('!plain:x');
  expect(roomPathId(copy, [copy, lounge])).toBe('#lounge:x');
});
