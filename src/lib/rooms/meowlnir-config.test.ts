import { expect, test } from 'vitest';

import {
  addProtectedRoom,
  addWatchedList,
  moveWatchedList,
  patternLines,
  protectedRooms,
  protectionConfig,
  removeProtectedRoom,
  setProtectionEnabled,
  setProtectionField,
  setSkipAcl,
  setWatchedListFlag,
  unknownProtections,
  watchedLists,
} from './meowlnir-config';

const rooms = {
  rooms: ['!a:example.org', '!b:example.org'],
  skip_acl: ['!b:example.org'],
  obfuscate_bans: true,
  policy_server_notification_room: '!notices:example.org',
  protections: { no_media: { allow_images: true, ignore_users: ['@bot:example.org'] } },
};

test('reads protected rooms with their server ACL choice', () => {
  expect(protectedRooms(rooms)).toEqual([
    { roomId: '!a:example.org', skipAcl: false },
    { roomId: '!b:example.org', skipAcl: true },
  ]);
  expect(protectedRooms(null)).toEqual([]);
  expect(protectedRooms({ rooms: 'nope' })).toEqual([]);
});

test('room edits keep the keys this client does not model', () => {
  const added = addProtectedRoom(rooms, '!c:example.org');
  expect(added).toEqual({
    ...rooms,
    rooms: ['!a:example.org', '!b:example.org', '!c:example.org'],
  });
  expect(addProtectedRoom(rooms, '!a:example.org').rooms).toEqual(rooms.rooms);

  expect(removeProtectedRoom(rooms, '!b:example.org')).toEqual({
    ...rooms,
    rooms: ['!a:example.org'],
    skip_acl: [],
  });
  expect(setSkipAcl(rooms, '!a:example.org', true).skip_acl).toEqual([
    '!b:example.org',
    '!a:example.org',
  ]);
  expect(setSkipAcl(rooms, '!b:example.org', false).skip_acl).toEqual([]);
});

const lists = {
  lists: [
    { room_id: '!one:example.org', shortcode: 'one', auto_unban: true, future_flag: 3 },
    { room_id: '!two:example.org', name: 'Second', dont_apply: true },
    { room_id: '!one:example.org', shortcode: 'duplicate' },
    'junk',
  ],
};

test('reads watched lists in precedence order and drops duplicates', () => {
  expect(watchedLists(lists)).toEqual([
    {
      roomId: '!one:example.org',
      name: null,
      shortcode: 'one',
      dont_apply: false,
      dont_apply_acl: false,
      auto_unban: true,
      auto_suspend: false,
      dont_notify_on_change: false,
    },
    {
      roomId: '!two:example.org',
      name: 'Second',
      shortcode: null,
      dont_apply: true,
      dont_apply_acl: false,
      auto_unban: false,
      auto_suspend: false,
      dont_notify_on_change: false,
    },
  ]);
});

test('list edits keep unknown flags and reorder by precedence', () => {
  const moved = moveWatchedList(lists, '!two:example.org', -1);
  expect(moved.lists).toEqual([
    { room_id: '!two:example.org', name: 'Second', dont_apply: true },
    { room_id: '!one:example.org', shortcode: 'one', auto_unban: true, future_flag: 3 },
  ]);
  expect(moveWatchedList(lists, '!one:example.org', -1)).toBe(lists);

  expect(setWatchedListFlag(lists, '!one:example.org', 'auto_suspend', true).lists).toContainEqual({
    room_id: '!one:example.org',
    shortcode: 'one',
    auto_unban: true,
    auto_suspend: true,
    future_flag: 3,
  });

  expect(addWatchedList({}, '!new:example.org', 'new').lists).toEqual([
    { room_id: '!new:example.org', shortcode: 'new', auto_unban: true },
  ]);
  expect(addWatchedList(lists, '!one:example.org', 'again')).toBe(lists);
});

test('a protection is on while its key exists, and keeps settings it does not show', () => {
  expect(protectionConfig(rooms, 'no_media')).toEqual(rooms.protections.no_media);
  expect(protectionConfig(rooms, 'anti_flood')).toBeNull();

  const enabled = setProtectionEnabled(rooms, 'anti_flood', true);
  expect(protectionConfig(enabled, 'anti_flood')).toEqual({});
  expect(setProtectionEnabled(enabled, 'no_media', true).protections).toEqual(enabled.protections);

  const limited = setProtectionField(enabled, 'anti_flood', 'limit', 10);
  expect(protectionConfig(limited, 'anti_flood')).toEqual({ limit: 10 });
  expect(setProtectionField(rooms, 'no_media', 'allow_files', true).protections).toEqual({
    no_media: { allow_images: true, allow_files: true, ignore_users: ['@bot:example.org'] },
  });

  const disabled = setProtectionEnabled(rooms, 'no_media', false);
  expect(disabled).not.toHaveProperty('protections');
  expect(disabled.obfuscate_bans).toBe(true);
});

test('protections this client does not know are listed, not dropped', () => {
  const content = { protections: { no_media: {}, from_the_future: { level: 2 } } };
  expect(unknownProtections(content)).toEqual(['from_the_future']);
  expect(setProtectionEnabled(content, 'no_media', false).protections).toEqual({
    from_the_future: { level: 2 },
  });
});

test('patterns are one per line', () => {
  expect(patternLines(' spam \n\nscam\nspam')).toEqual(['spam', 'scam']);
});
