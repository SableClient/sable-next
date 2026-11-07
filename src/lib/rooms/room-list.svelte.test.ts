import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomListItemView } from '#src/generated/protocol';

import { countNotifications, notifications } from '#lib/features/inbox/inbox.js';

import { RoomList, hasDirectRoom, roomListOptions, roomPathId } from './room-list.svelte.js';
import { withCounts } from './summary-fixtures.js';
import { badgeView, sectionsUpdate, sectionView } from '#lib/test-support/room-sections.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function snapshotOf(rooms: unknown[], extra: object = {}): string {
  return JSON.stringify({ rooms, sections: [], badges: [], quiet_rooms: [], ...extra });
}

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
    } as RoomListItemView),
    withCounts({
      room_id: '!plain:example.org',
      is_direct: false,
      display_name: '!plain:example.org',
    } as RoomListItemView),
  ];
  const core = {
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
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
  } as RoomListItemView);
  const quiet = withCounts({
    room_id: '!quiet',
    state: 'joined',
    unread: 3,
    notifying: 0,
    highlight: 0,
    notification: { room: null, default: 'all' },
  } as RoomListItemView);
  const listeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    },
    rpc: {
      timeline: {
        subscribeRoomList: () => Promise.resolve({ subscription: 1, rooms: [loud, quiet] }),
        unsubscribe: async () => {},
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);
  await roomList.start();
  expect(countNotifications(roomList.rooms, roomList.badgeUnreadFor)).toBe(0);

  const emit = (event: object) => {
    for (const listener of listeners)
      listener({ type: 'room_list_diff', subscription: 1, ...event });
  };
  emit({
    diffs: [],
    sections: sectionsUpdate([], { badges: [badgeView('!loud', { unread: 2, notifying: 2 })] }),
  });
  expect(countNotifications(roomList.rooms, roomList.badgeUnreadFor)).toBe(2);
  expect(
    notifications(roomList.rooms, 'all', roomList.badgeUnreadFor).map((room) => room.room_id)
  ).toEqual(['!loud']);

  const muted = withCounts({ ...loud, notification: { room: 'mute', default: 'all' } });
  emit({
    diffs: [{ op: 'set', index: 0, value: muted }],
    sections: sectionsUpdate([], { badges: [] }),
  });
  expect(countNotifications(roomList.rooms, roomList.badgeUnreadFor)).toBe(0);
  roomList.stop();
});

test('clears a room avatar when a room-list diff supplies null', async () => {
  const room = {
    room_id: '!room:example.org',
    avatar_url: 'mxc://example.org/avatar',
    display_name: '!room:example.org',
  } as RoomListItemView;
  const clearedRoom = { ...room, avatar_url: null };
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
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
  const room = {
    room_id: '!room:example.org',
    display_name: '!room:example.org',
  } as RoomListItemView;
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
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

test('stops a user typing once their message arrives in the room list', async () => {
  const room = {
    room_id: '!room:example.org',
    display_name: '!room:example.org',
    latest_event: { sender: '@bob:example.org', body: 'old', event_id: '$1', sending: false },
  } as RoomListItemView;
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  for (const listener of eventListeners) {
    listener({
      type: 'typing',
      room_id: room.room_id,
      user_ids: ['@alice:example.org', '@bob:example.org'],
    });
  }
  const sent = { ...room, latest_event: { ...room.latest_event, event_id: '$2' } };
  for (const listener of eventListeners) {
    listener({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [{ op: 'set', index: 0, value: sent }],
      sections: null,
    });
  }

  expect(roomList.typingUserIds(room.room_id)).toEqual(['@alice:example.org']);
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
    display_name: 'Persisted',
  } as RoomListItemView);
  const home = sectionView('home', { rooms: [room.room_id] });
  stubLocalStorage().set(
    'sable.room-list.v2.acct',
    snapshotOf([room], {
      sections: [home],
      badges: [badgeView(room.room_id, { unread: 2, notifying: 2 })],
      quiet_rooms: [room.room_id],
    })
  );
  let resolveSubscription: (value: {
    subscription: number;
    rooms: RoomListItemView[];
  }) => void = () => {};
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(
          () =>
            new Promise<{ subscription: number; rooms: RoomListItemView[] }>((resolve) => {
              resolveSubscription = resolve;
            })
        ),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  const started = roomList.start();
  expect(roomList.rooms).toEqual([room]);
  expect(roomList.section('home')).toEqual(home);
  expect(roomList.badgeUnreadFor(room)).toEqual({
    unread: 2,
    notifying: 2,
    highlight: 0,
    marked: false,
  });
  expect(roomList.quietRoomIds).toEqual(new Set([room.room_id]));

  resolveSubscription({ subscription: 1, rooms: [] });
  await started;
  expect(roomList.rooms).toEqual([room]);

  roomList.stop();
});

test('a snapshot from a build before resolved counts paints nothing', () => {
  stubLocalStorage().set(
    'sable.room-list.v2.acct',
    snapshotOf([{ room_id: '!old:example.org', unread: 4 }])
  );
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => new Promise(() => {})),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  void roomList.start();
  expect(roomList.rooms).toEqual([]);
  roomList.stop();
});

test('is not settled on a painted snapshot', async () => {
  const room = withCounts({
    room_id: '!room:example.org',
    display_name: '!room:example.org',
  } as RoomListItemView);
  stubLocalStorage().set('sable.room-list.v2.acct', snapshotOf([room]));
  let resolveSubscription: (value: {
    subscription: number;
    rooms: RoomListItemView[];
  }) => void = () => {};
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(
          () =>
            new Promise<{ subscription: number; rooms: RoomListItemView[] }>((resolve) => {
              resolveSubscription = resolve;
            })
        ),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
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
  const first = withCounts({
    room_id: '!first:example.org',
    display_name: '!first:example.org',
  } as RoomListItemView);
  const second = withCounts({
    room_id: '!second:example.org',
    display_name: '!second:example.org',
  } as RoomListItemView);
  stubLocalStorage().set('sable.room-list.v2.acct', snapshotOf([first, second]));
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
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
  const listed = {
    room_id: '!listed:example.org',
    display_name: '!listed:example.org',
  } as RoomListItemView;
  const late = {
    room_id: '!late:example.org',
    display_name: '!late:example.org',
  } as RoomListItemView;
  const eventListeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {};
    }),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [listed] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
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
  const room = {
    room_id: '!live:example.org',
    name: 'Live',
    display_name: 'Live',
  } as RoomListItemView;
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  expect(stored.has('sable.room-list.v2.acct')).toBe(false);
  vi.advanceTimersByTime(1_000);
  expect(JSON.parse(stored.get('sable.room-list.v2.acct') ?? '{}')).toEqual({
    rooms: [room],
    sections: [],
    badges: [],
    quiet_rooms: [],
  });

  roomList.stop();
  vi.useRealTimers();
});

test('defers room-list snapshot writes until presentation resumes', async () => {
  vi.useFakeTimers();
  const stored = stubLocalStorage();
  const room = {
    room_id: '!live:example.org',
    name: 'Live',
    display_name: 'Live',
  } as RoomListItemView;
  const core = {
    session: { account_id: 'acct' },
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [room] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  roomList.setPresentationActive(false);
  await roomList.start();
  vi.advanceTimersByTime(1_000);
  expect(stored.has('sable.room-list.v2.acct')).toBe(false);

  roomList.setPresentationActive(true);
  expect(JSON.parse(stored.get('sable.room-list.v2.acct') ?? '{}')).toEqual({
    rooms: [room],
    sections: [],
    badges: [],
    quiet_rooms: [],
  });

  roomList.stop();
  vi.useRealTimers();
});

test('looks rooms up by id and labels them by what the core shows', () => {
  const roomList = new RoomList({} as CoreClient);
  roomList.rooms = [
    { room_id: '!named:example.org', display_name: 'Named' },
    { room_id: '!aliased:example.org', display_name: '#aliased:example.org' },
    { room_id: '!bare:example.org', display_name: '!bare:example.org' },
  ] as RoomListItemView[];

  expect(roomList.byId('!aliased:example.org')).toBe(roomList.rooms[1]);
  expect(roomList.byId('!missing:example.org')).toBeUndefined();
  expect(roomList.byId(null)).toBeUndefined();
  expect(roomList.labelFor('!named:example.org')).toBe('Named');
  expect(roomList.labelFor('!aliased:example.org')).toBe('#aliased:example.org');
  expect(roomList.labelFor('!bare:example.org')).toBe('!bare:example.org');
  expect(roomList.labelFor('!missing:example.org')).toBe('!missing:example.org');

  roomList.rooms = [
    { room_id: '!missing:example.org', display_name: 'Arrived' },
  ] as RoomListItemView[];
  expect(roomList.labelFor('!missing:example.org')).toBe('Arrived');
});

test('badges, quiet rooms and sections come from the core and replace each other', async () => {
  const quiet = withCounts({
    room_id: '!quiet:example.org',
    unread: 4,
    notifying: 4,
    highlight: 1,
    marked_unread: false,
    notification: { room: null, default: 'all' },
  } as unknown as RoomListItemView);
  const listeners: ((event: unknown) => void)[] = [];
  const core = {
    subscribeEvents: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    rpc: {
      timeline: {
        subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms: [quiet] })),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  expect(roomList.badgeUnreadFor(quiet)).toEqual({ unread: 0, highlight: 0, marked: false });
  expect(roomList.section('home')).toBeUndefined();

  const emit = (sections: ReturnType<typeof sectionsUpdate>) => {
    for (const listener of listeners)
      listener({ type: 'room_list_diff', subscription: 1, diffs: [], sections });
  };
  emit(
    sectionsUpdate([sectionView('home', { rooms: [quiet.room_id] }), sectionView('direct')], {
      badges: [badgeView(quiet.room_id, { unread: 1, highlight: 1 })],
      quiet_rooms: [quiet.room_id],
    })
  );

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
  expect(roomList.quietRoomIds).toEqual(new Set([quiet.room_id]));
  expect(roomList.section('home')?.rooms).toEqual([quiet.room_id]);

  emit(sectionsUpdate([sectionView('home', { rooms: [] })], { removed: ['direct'] }));
  expect(roomList.section('home')?.rooms).toEqual([]);
  expect(roomList.section('direct')).toBeUndefined();
  expect(roomList.badgeUnreadFor(quiet).unread).toBe(1);

  emit(sectionsUpdate([], { badges: [], quiet_rooms: [] }));
  expect(roomList.badgeUnreadFor(quiet).unread).toBe(0);
  expect(roomList.quietRoomIds.size).toBe(0);

  roomList.stop();
});

test('subscribes with the room list options and resends them when they change', async () => {
  const subscribeRoomList = vi.fn(() => Promise.resolve({ subscription: 1, rooms: [] }));
  const setRoomListOptions = vi.fn(() => Promise.resolve());
  const core = {
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      timeline: {
        subscribeRoomList,
        setRoomListOptions,
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  const options = roomListOptions();
  expect(subscribeRoomList).toHaveBeenCalledWith({ options });
  expect(setRoomListOptions).not.toHaveBeenCalled();

  roomList.setOptions({ ...options, subspace_depth: options.subspace_depth + 1 });
  expect(setRoomListOptions).toHaveBeenCalledTimes(1);
  roomList.stop();
});

test('warms each visible room once, batched into one command', () => {
  vi.useFakeTimers();
  const warmRooms = vi.fn(() => Promise.resolve());
  const roomList = new RoomList({ rpc: { timeline: { warmRooms } } } as unknown as CoreClient);

  roomList.warm('!a:example.org');
  roomList.warm('!b:example.org');
  roomList.warm('!a:example.org');
  vi.advanceTimersByTime(100);
  roomList.warm('!b:example.org');
  vi.advanceTimersByTime(100);

  expect(warmRooms).toHaveBeenCalledTimes(1);
  expect(warmRooms).toHaveBeenCalledWith({ room_ids: ['!a:example.org', '!b:example.org'] });
  vi.useRealTimers();
});

test('stopping drops pending warms and forgets what was warmed', () => {
  vi.useFakeTimers();
  const warmRooms = vi.fn(() => Promise.resolve());
  const roomList = new RoomList({
    rpc: { timeline: { warmRooms, unsubscribe: vi.fn(() => Promise.resolve()) } },
  } as unknown as CoreClient);

  roomList.warm('!a:example.org');
  roomList.stop();
  vi.advanceTimersByTime(100);
  expect(warmRooms).not.toHaveBeenCalled();

  roomList.warm('!a:example.org');
  vi.advanceTimersByTime(100);
  expect(warmRooms).toHaveBeenCalledWith({ room_ids: ['!a:example.org'] });
  vi.useRealTimers();
});

test('a room path uses its alias only when the room is the first live owner of it', () => {
  const room = (room_id: string, canonical_alias: string | null, is_tombstoned = false) =>
    ({ room_id, canonical_alias, is_tombstoned }) as RoomListItemView;
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

test('finds a live direct room with a user', () => {
  const room = (is_direct: boolean, direct_targets: string[], is_tombstoned = false) =>
    ({ is_direct, direct_targets, is_tombstoned }) as RoomListItemView;

  expect(hasDirectRoom([room(true, ['@alice:x'])], '@alice:x')).toBe(true);
  expect(hasDirectRoom([room(true, ['@bob:x'])], '@alice:x')).toBe(false);
  expect(hasDirectRoom([room(false, ['@alice:x'])], '@alice:x')).toBe(false);
  expect(hasDirectRoom([room(true, ['@alice:x'], true)], '@alice:x')).toBe(false);
});
