import { afterEach, expect, test, vi } from 'vitest';

import type {
  NotificationModeView,
  RoomListItemView,
  SpaceNotificationView,
} from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

import { toasts } from '#lib/ui/toasts.svelte.js';

import { setNotificationMode, spaceNotifications } from './space-notifications.svelte';

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
    bridge: null,
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

function fakeCore(spaces: SpaceNotificationView[], exempt: string[] = []) {
  const view = () => ({ spaces, exempt_rooms: exempt });
  const setRoomsNotificationMode = vi.fn(() => Promise.resolve(null));
  const setRoomNotificationMode = vi.fn(() => Promise.resolve(null));
  const setSpaceNotification = vi.fn(
    ({ space_id, mode }: { space_id: string; mode: NotificationModeView | null }) => {
      spaces = [
        ...spaces.filter((entry) => entry.space_id !== space_id),
        ...(mode === null ? [] : [{ space_id, mode }]),
      ];
      return Promise.resolve(view());
    }
  );
  const setSpaceNotificationExempt = vi.fn(
    ({ room_id, exempt: next }: { room_id: string; exempt: boolean }) => {
      exempt = [...exempt.filter((id) => id !== room_id), ...(next ? [room_id] : [])];
      return Promise.resolve(view());
    }
  );
  const core = {
    subscribeEvents: () => () => {},
    rpc: {
      account: {
        spaceNotifications: () => Promise.resolve(view()),
        setSpaceNotification,
        setSpaceNotificationExempt,
      },
      notifications: { setRoomsNotificationMode, setRoomNotificationMode },
    },
  } as unknown as CoreClient;
  return {
    core,
    setRoomsNotificationMode,
    setRoomNotificationMode,
    setSpaceNotification,
    setSpaceNotificationExempt,
  };
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

  expect(await spaceNotifications.set('!space', 'mute', rooms)).toBe(1);
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

test('an exempt room keeps the default and can follow its space again', async () => {
  const fake = fakeCore([{ space_id: '!space', mode: 'mute' }], ['!room']);
  spaceNotifications.start(fake.core);
  await vi.waitFor(() => {
    expect(spaceNotifications.exempt.has('!room')).toBe(true);
  });
  const room = (id: string) => ({ ...space('!x', []), room_id: id, room_kind: 'text' as const });
  const rooms = [space('!space', ['!room']), room('!room')];

  spaceNotifications.apply(rooms);
  expect(fake.setRoomsNotificationMode).not.toHaveBeenCalledWith(
    expect.objectContaining({ room_ids: expect.arrayContaining(['!room']) as unknown })
  );
  expect(spaceNotifications.spaceModes(rooms).get('!room')).toBe('mute');

  await spaceNotifications.setExempt(rooms[1], false);
  expect(fake.setSpaceNotificationExempt).toHaveBeenCalledWith({ room_id: '!room', exempt: false });
  expect(fake.setRoomNotificationMode).toHaveBeenCalledWith({ room_id: '!room', mode: null });
  expect(spaceNotifications.inherited(rooms).get('!room')).toBe('mute');
});

test('changing a space mode says how many rooms it moved and can be undone', async () => {
  const fake = fakeCore([]);
  spaceNotifications.start(fake.core);
  const undoable = vi.spyOn(toasts, 'undoable');
  const roomList = {
    rooms: [space('!space', ['!a', '!b']), room('!a', null), room('!b', null)],
  };

  await setNotificationMode(fake.core, roomList, roomList.rooms[0], 'mute');

  expect(undoable).toHaveBeenCalledWith(
    '!space and 2 rooms in it now use Mute',
    expect.objectContaining({ label: 'Undo' })
  );
  undoable.mock.calls[0][1].onUndo();
  await vi.waitFor(() => {
    expect(fake.setSpaceNotification).toHaveBeenLastCalledWith({ space_id: '!space', mode: null });
  });
  undoable.mockRestore();
});
