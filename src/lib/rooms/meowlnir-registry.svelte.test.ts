// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import {
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
const core = { rpc: { room_state: { event, fullState } } } as unknown as CoreClient;

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
