// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomListItemView } from '#src/generated/protocol';

import {
  discoverMeowlnirRooms,
  forgetMeowlnirRoom,
  meowlnirFor,
  noteRoomOpened,
  rememberMeowlnirRoom,
} from './meowlnir-registry.svelte';

const MANAGEMENT = '!management:example.org';
const ME = '@me:example.org';

const config = {
  protectedRooms: { rooms: ['!lobby:example.org'] },
  watchedLists: {
    lists: [
      { room_id: '!spam:example.org', shortcode: 'spam', name: 'Spam list' },
      { room_id: '!unnamed:example.org' },
    ],
  },
};

let state: Record<string, unknown>;
const event = vi.fn((params: { event_type: string }) =>
  Promise.resolve(state[params.event_type] ?? null)
);
const fullState = vi.fn(() =>
  Promise.resolve(
    Object.entries(state).map(([type, content]) => ({ type, state_key: '', content }))
  )
);
const levels = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: {},
  users: {},
  notifications_room: 50,
};
const powerLevels = vi.fn(() => Promise.resolve(levels));
const permissions = vi.fn(() => Promise.resolve({ own_power_level: 100 }));
const core = {
  rpc: { room_state: { event, fullState }, members: { powerLevels, permissions } },
} as unknown as CoreClient;

function listed(room_id: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return {
    room_id,
    state: 'joined',
    is_direct: false,
    room_kind: 'text',
    join_rule: 'invite',
    ...overrides,
  } as RoomListItemView;
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetMeowlnirRoom(MANAGEMENT, ME);
  state = {
    'fi.mau.meowlnir.protected_rooms': config.protectedRooms,
    'fi.mau.meowlnir.watched_lists': config.watchedLists,
  };
});

test('a protected room finds its management room, for the account that moderates it', () => {
  rememberMeowlnirRoom(MANAGEMENT, ME, config);

  expect(meowlnirFor('!lobby:example.org', ME)).toEqual({
    roomId: MANAGEMENT,
    userId: ME,
    protectedRooms: ['!lobby:example.org'],
    lists: [{ shortcode: 'spam', name: 'Spam list' }],
  });
  expect(meowlnirFor('!lobby:example.org', '@other:example.org')).toBeNull();
  expect(meowlnirFor('!elsewhere:example.org', ME)).toBeNull();
});

test('a management room without a usable list offers nothing', () => {
  rememberMeowlnirRoom(MANAGEMENT, ME, {
    protectedRooms: config.protectedRooms,
    watchedLists: { lists: [{ room_id: '!unnamed:example.org' }] },
  });

  expect(meowlnirFor('!lobby:example.org', ME)).toBeNull();
});

test('opening a management room as a moderator records it, and survives a reload', async () => {
  await noteRoomOpened(core, MANAGEMENT, ME, true);

  expect(meowlnirFor('!lobby:example.org', ME)?.roomId).toBe(MANAGEMENT);
  expect(JSON.parse(localStorage.getItem('sable-meowlnir-rooms') ?? '[]')).toHaveLength(1);
});

test('rooms the account does not moderate are never asked for Meowlnir settings', async () => {
  await noteRoomOpened(core, '!lobby:example.org', ME, false);

  expect(event).not.toHaveBeenCalled();
  expect(fullState).not.toHaveBeenCalled();
});

test('a management room is dropped once the role or the settings are gone', async () => {
  rememberMeowlnirRoom(MANAGEMENT, ME, config);
  await noteRoomOpened(core, MANAGEMENT, ME, false);
  expect(meowlnirFor('!lobby:example.org', ME)).toBeNull();

  rememberMeowlnirRoom(MANAGEMENT, ME, config);
  state = {};
  await noteRoomOpened(core, MANAGEMENT, ME, true);
  expect(meowlnirFor('!lobby:example.org', ME)).toBeNull();
});

test('a management room is found without being opened, and each room is asked once', async () => {
  event.mockImplementation((params: { event_type: string; room_id?: string }) =>
    Promise.resolve(params.room_id === MANAGEMENT ? (state[params.event_type] ?? null) : null)
  );
  const rooms = [
    listed(MANAGEMENT),
    listed('!private:example.org'),
    listed('!public:example.org', { join_rule: 'public' }),
    listed('!dm:example.org', { is_direct: true }),
    listed('!space:example.org', { room_kind: 'space' }),
  ];

  await discoverMeowlnirRooms(core, ME, rooms);

  expect(meowlnirFor('!lobby:example.org', ME)?.roomId).toBe(MANAGEMENT);
  expect(event.mock.calls.map(([params]) => (params as { room_id?: string }).room_id)).toEqual([
    MANAGEMENT,
    '!private:example.org',
  ]);

  event.mockClear();
  await discoverMeowlnirRooms(core, ME, rooms);
  expect(event).not.toHaveBeenCalled();
});

test('a room that could not be asked is asked again, and a room without the role is skipped', async () => {
  const other = '@other:example.org';
  event.mockRejectedValueOnce(new Error('offline'));
  await discoverMeowlnirRooms(core, other, [listed('!retry:example.org')]);
  event.mockClear();
  await discoverMeowlnirRooms(core, other, [listed('!retry:example.org')]);
  expect(event).toHaveBeenCalledTimes(1);

  event.mockImplementation((params) => Promise.resolve(state[params.event_type] ?? null));
  permissions.mockResolvedValueOnce({ own_power_level: 0 });
  await discoverMeowlnirRooms(core, other, [listed('!managed:example.org')]);
  expect(permissions).toHaveBeenCalledTimes(1);
  expect(meowlnirFor('!lobby:example.org', other)).toBeNull();
});
