import { afterEach, expect, test, vi } from 'vitest';

import type {
  NotificationModeView,
  RoomListItemView,
  SpaceNotificationView,
} from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

import { spaceNotifications } from './space-notifications.svelte';

function room(
  room_id: string,
  rule: NotificationModeView | null,
  overrides: Partial<RoomListItemView> = {}
): RoomListItemView {
  return withCounts({
    room_id,
    canonical_alias: null,
    name: null,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    room_kind: 'text',
    is_tombstoned: false,
    call_participants: [],
    screen_sharers: [],
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    notification: { room: rule, default: 'mentions' },
    ...overrides,
  });
}

function space(room_id: string, children: string[]): RoomListItemView {
  return room(room_id, null, {
    room_kind: 'space',
    space_children: children.map((child) => ({
      room_id: child,
      via: [],
      order: null,
      origin_server_ts: 0,
      suggested: false,
    })),
  });
}

function fakeCore(stored: SpaceNotificationView[]) {
  const setRoomsNotificationMode = vi.fn(() => Promise.resolve(null));
  const setSpaceNotification = vi.fn(
    ({ space_id, mode }: { space_id: string; mode: NotificationModeView | null }) => {
      stored = [
        ...stored.filter((entry) => entry.space_id !== space_id),
        ...(mode === null ? [] : [{ space_id, mode }]),
      ];
      return Promise.resolve(stored);
    }
  );
  const core = {
    subscribeEvents: () => () => {},
    rpc: {
      account: { spaceNotifications: () => Promise.resolve(stored), setSpaceNotification },
      notifications: { setRoomsNotificationMode },
    },
  } as unknown as CoreClient;
  return { core, setRoomsNotificationMode, setSpaceNotification };
}

afterEach(() => {
  spaceNotifications.stop();
});

test('rooms without a rule of their own take their space mode, once', async () => {
  const fake = fakeCore([{ space_id: '!space', mode: 'mute' }]);
  spaceNotifications.start(fake.core);
  await vi.waitFor(() => {
    expect(spaceNotifications.modeOf('!space')).toBe('mute');
  });
  const rooms = [
    space('!space', ['!new', '!own', '!other']),
    room('!new', null),
    room('!own', 'all'),
    room('!other', null),
  ];

  fake.setRoomsNotificationMode.mockRejectedValueOnce(new Error('rejected'));
  spaceNotifications.apply(rooms);
  spaceNotifications.apply(rooms);

  expect(fake.setRoomsNotificationMode).toHaveBeenCalledOnce();
  expect(fake.setRoomsNotificationMode).toHaveBeenCalledWith({
    room_ids: ['!space', '!new', '!other'],
    mode: 'mute',
  });
});

test('changing a space mode moves the rooms that carried the old one', async () => {
  const fake = fakeCore([{ space_id: '!space', mode: 'all' }]);
  spaceNotifications.start(fake.core);
  await vi.waitFor(() => {
    expect(spaceNotifications.modeOf('!space')).toBe('all');
  });
  const rooms = [
    space('!space', ['!following', '!own']),
    room('!following', 'all'),
    room('!own', 'mentions'),
  ];

  await spaceNotifications.set('!space', 'mute', rooms);
  expect(fake.setSpaceNotification).toHaveBeenCalledWith({ space_id: '!space', mode: 'mute' });
  expect(fake.setRoomsNotificationMode).toHaveBeenCalledWith({
    room_ids: ['!space', '!following'],
    mode: 'mute',
  });

  fake.setRoomsNotificationMode.mockClear();
  await spaceNotifications.set('!space', null, [
    {
      ...space('!space', ['!following', '!own']),
      notification: { room: 'mute', default: 'mentions' },
    },
    room('!following', 'mute'),
    room('!own', 'mentions'),
  ]);
  expect(spaceNotifications.modeOf('!space')).toBeNull();
  expect(fake.setRoomsNotificationMode).toHaveBeenCalledWith({
    room_ids: ['!space', '!following'],
    mode: null,
  });
});

test('custom rooms are the spaces with a mode and the rooms that differ from theirs', async () => {
  const fake = fakeCore([{ space_id: '!space', mode: 'mute' }]);
  spaceNotifications.start(fake.core);
  await vi.waitFor(() => {
    expect(spaceNotifications.modeOf('!space')).toBe('mute');
  });

  const custom = spaceNotifications.custom([
    space('!space', ['!following', '!own']),
    room('!following', 'mute'),
    room('!own', 'all'),
    room('!alone', 'mentions'),
    room('!default', null),
    room('!left', 'all', { state: 'left' }),
  ]);

  expect(custom.map(({ room, mode }) => [room.room_id, mode])).toEqual([
    ['!space', 'mute'],
    ['!own', 'all'],
    ['!alone', 'mentions'],
  ]);
});
