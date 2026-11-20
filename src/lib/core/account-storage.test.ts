// @vitest-environment happy-dom

import { beforeEach, expect, test } from 'vitest';

import { cachedAccountConfig, storeAccountConfig } from '#lib/config/account-discovery.js';
import { lastRoomId, lastRoomSection, rememberLastRoom } from '#lib/rooms/last-room.js';
import { readRoomListSnapshot, writeRoomListSnapshot } from '#lib/rooms/room-list-snapshot.js';
import { syncBaseKey } from '#lib/settings/account-sync.svelte.js';

import { forgetAccountStorage } from './account-storage';

beforeEach(() => {
  localStorage.clear();
});

test('forgets what every account cached and keeps the device preferences', () => {
  writeRoomListSnapshot('a1', { rooms: [], sections: [], badges: [], quiet_rooms: [] });
  rememberLastRoom('a1', '!room:example.org', 'home');
  storeAccountConfig('a1', 'https://example.org', { key: 'value' } as never);
  localStorage.setItem(syncBaseKey('a1', 'moe.sable.settings'), '{}');
  localStorage.setItem('sable-preferences', '{}');
  expect(readRoomListSnapshot('a1')).not.toBeNull();
  expect(lastRoomId('a1')).toBe('!room:example.org');
  expect(cachedAccountConfig('a1', 'https://example.org')).not.toBeNull();

  forgetAccountStorage();

  expect(readRoomListSnapshot('a1')).toBeNull();
  expect(lastRoomId('a1')).toBeNull();
  expect(lastRoomSection('a1')).toBeNull();
  expect(cachedAccountConfig('a1', 'https://example.org')).toBeNull();
  expect(localStorage.getItem(syncBaseKey('a1', 'moe.sable.settings'))).toBeNull();
  expect(localStorage.getItem('sable-preferences')).toBe('{}');
});
