// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomListItemView, RoomsView } from '#src/generated/protocol';

import { countNotifications, notifications } from '#lib/features/inbox/inbox.js';
import { FakeRuntime, roomsView } from '#lib/test-support/fake-runtime.js';

import { setQuiet } from './quiet-rooms.svelte.js';
import { RoomList, hasDirectRoom, roomPathId } from './room-list.svelte.js';
import { withCounts } from './summary-fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
  setQuiet('!quiet:example.org', false);
});

async function started(state: RoomsView) {
  const runtime = new FakeRuntime({ rooms: state });
  const roomList = new RoomList(() => runtime.client());
  await roomList.start();
  return { runtime, roomList };
}

test("reads a room's mode off its summary", async () => {
  const { roomList } = await started(
    roomsView([
      withCounts({
        room_id: '!muted:example.org',
        notification: { room: 'mute', default: 'all' },
      } as RoomListItemView),
      withCounts({ room_id: '!plain:example.org', is_direct: false } as RoomListItemView),
    ])
  );

  expect(roomList.notificationOverride('!muted:example.org')).toBe('mute');
  expect(roomList.notificationMode('!muted:example.org')).toBe('mute');
  expect(roomList.notificationOverride('!plain:example.org')).toBeNull();
  expect(roomList.notificationMode('!plain:example.org')).toBe('mentions');
  expect(roomList.notificationMode('!missing:example.org')).toBeNull();
  roomList.stop();
});

test('shows what the slice serves and follows its patches', async () => {
  const first = { room_id: '!a:example.org', name: 'A' } as RoomListItemView;
  const { runtime, roomList } = await started(
    roomsView([first], { typing: { '!a:example.org': ['@u'] } })
  );

  expect(roomList.rooms).toEqual([first]);
  expect(roomList.settled).toBe(true);
  expect(roomList.typingUserIds('!a:example.org')).toEqual(['@u']);
  expect(roomList.typingUserIds('!b:example.org')).toEqual([]);

  const second = { room_id: '!b:example.org', name: 'B' } as RoomListItemView;
  runtime.set('rooms', roomsView([first, second]));
  expect(roomList.rooms).toEqual([first, second]);
  expect(roomList.byId('!b:example.org')).toBe(roomList.rooms[1]);
  roomList.stop();
});

test('is not settled before the slice has answered or while it serves a saved list', async () => {
  const saved = roomsView([{ room_id: '!old:example.org' } as RoomListItemView], {
    settled: false,
  });
  const runtime = new FakeRuntime({ rooms: saved });
  const roomList = new RoomList(() => runtime.client());
  expect(roomList.settled).toBe(false);
  expect(roomList.rooms).toEqual([]);

  await roomList.start();
  expect(roomList.settled).toBe(false);
  expect(roomList.rooms).toHaveLength(1);

  runtime.set('rooms', roomsView([{ room_id: '!new:example.org' } as RoomListItemView]));
  expect(roomList.settled).toBe(true);
  roomList.stop();
});

test('badges and quiet rooms come from the slice', async () => {
  const loud = withCounts({
    room_id: '!loud',
    state: 'joined',
    unread: 2,
    notifying: 2,
  } as RoomListItemView);
  const quiet = withCounts({ room_id: '!quiet', state: 'joined', unread: 3 } as RoomListItemView);
  const { runtime, roomList } = await started(
    roomsView([loud, quiet], {
      badges: { '!loud': { unread: 2, highlight: 0, marked: false, notifying: 2 } },
      quiet_room_ids: ['!quiet'],
      space_unread: { '!space': { unread: 5, highlight: 1, marked: false, notifying: 0 } },
    })
  );

  expect(countNotifications(roomList.rooms, roomList.badgeUnreadFor)).toBe(2);
  expect(
    notifications(roomList.rooms, 'all', roomList.badgeUnreadFor).map((room) => room.room_id)
  ).toEqual(['!loud']);
  expect(roomList.badgeUnreadFor(quiet)).toEqual({
    unread: 0,
    highlight: 0,
    marked: false,
    notifying: 0,
  });
  expect(roomList.quietRoomIds.has('!quiet')).toBe(true);
  expect(roomList.spaceUnread.get('!space')?.unread).toBe(5);

  runtime.set('rooms', roomsView([loud, quiet]));
  expect(roomList.badgeUnreadFor(loud).notifying).toBe(0);
  roomList.stop();
});

test('sends the reader preferences to the slice, again when they change', async () => {
  const { runtime, roomList } = await started(roomsView([]));
  const sent = () =>
    runtime.dispatched
      .map(({ action }) => action as { type: string; quiet_targets: string[] })
      .filter((action) => action.type === 'set_preferences');
  flushSync();
  expect(sent().at(-1)).toMatchObject({
    quiet_targets: [],
    badge_defaults: { direct: expect.any(String) as string, group: expect.any(String) as string },
  });

  setQuiet('!quiet:example.org', true);
  flushSync();

  expect(sent().at(-1)?.quiet_targets).toEqual(['!quiet:example.org']);
  roomList.stop();
});

test('warms rooms through the slice, and only once it is started', async () => {
  const runtime = new FakeRuntime({ rooms: roomsView([]) });
  const roomList = new RoomList(() => runtime.client());
  roomList.warm('!early:example.org');
  await roomList.start();
  roomList.warm('!a:example.org');

  expect(
    runtime.dispatched.filter(({ action }) => (action as { type: string }).type === 'warm')
  ).toEqual([
    { target: { slice: 'rooms', key: null }, action: { type: 'warm', room_id: '!a:example.org' } },
  ]);
  roomList.stop();
});

test('stopping closes the subscription and forgets the rooms', async () => {
  const { runtime, roomList } = await started(
    roomsView([{ room_id: '!a:example.org' } as RoomListItemView])
  );

  roomList.stop();
  await Promise.resolve();

  expect(roomList.rooms).toEqual([]);
  expect(roomList.settled).toBe(false);
  expect(runtime.unsubscribed).toHaveLength(1);
});

test('waits for a room to be listed, and gives up after the timeout', async () => {
  const listed = { room_id: '!listed:example.org' } as RoomListItemView;
  const late = { room_id: '!late:example.org' } as RoomListItemView;
  const { runtime, roomList } = await started(roomsView([listed]));

  await roomList.whenListed(listed.room_id, 60_000);

  let arrived = false;
  const waiting = roomList.whenListed(late.room_id, 60_000).then(() => {
    arrived = true;
  });
  await Promise.resolve();
  expect(arrived).toBe(false);
  runtime.set('rooms', roomsView([listed, late]));
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

test('looks rooms up by id and labels them by name, then alias, then id', async () => {
  const { runtime, roomList } = await started(
    roomsView([
      { room_id: '!named:example.org', name: 'Named', canonical_alias: '#named:example.org' },
      { room_id: '!aliased:example.org', name: null, canonical_alias: '#aliased:example.org' },
      { room_id: '!bare:example.org', name: null, canonical_alias: null },
    ] as RoomListItemView[])
  );

  expect(roomList.byId('!aliased:example.org')).toBe(roomList.rooms[1]);
  expect(roomList.byId('!missing:example.org')).toBeUndefined();
  expect(roomList.byId(null)).toBeUndefined();
  expect(roomList.labelFor('!named:example.org')).toBe('Named');
  expect(roomList.labelFor('!aliased:example.org')).toBe('#aliased:example.org');
  expect(roomList.labelFor('!bare:example.org')).toBe('!bare:example.org');
  expect(roomList.labelFor('!missing:example.org')).toBe('!missing:example.org');

  runtime.set(
    'rooms',
    roomsView([{ room_id: '!missing:example.org', name: 'Arrived' }] as RoomListItemView[])
  );
  expect(roomList.labelFor('!missing:example.org')).toBe('Arrived');
  roomList.stop();
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
