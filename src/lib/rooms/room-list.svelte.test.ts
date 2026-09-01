import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { NotificationModeView } from '#src/generated/NotificationModeView';
import type { RoomSummary } from '#src/generated/RoomSummary';

import { RoomList } from './room-list.svelte.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function room(id: string, fields: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: id,
    is_direct: false,
    notification_mode: null,
    ...fields,
  } as RoomSummary;
}

function coreWith(
  rooms: RoomSummary[],
  defaults: { direct: NotificationModeView; group: NotificationModeView } = {
    direct: 'all',
    group: 'all',
  }
): { core: CoreClient; defaultNotificationModes: ReturnType<typeof vi.fn> } {
  const defaultNotificationModes = vi.fn(() => Promise.resolve(defaults));
  const core = {
    subscribeEvents: vi.fn(() => () => {}),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms })),
      defaultNotificationModes,
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  return { core, defaultNotificationModes };
}

test('hydrating the room list asks for the account defaults once, not once per room', async () => {
  const rooms = Array.from({ length: 20 }, (_, index) =>
    room(`!room-${String(index)}:example.org`)
  );
  const { core, defaultNotificationModes } = coreWith(rooms);
  const roomList = new RoomList(core);

  await roomList.start();
  await vi.waitFor(() => {
    expect(defaultNotificationModes).toHaveBeenCalledTimes(1);
  });

  roomList.stop();
});

test("a room's own override is what mutes it", async () => {
  const rooms = [
    room('!muted:example.org', { notification_mode: 'mute' }),
    room('!loud:example.org', { notification_mode: 'all' }),
    room('!default:example.org'),
  ];
  const { core } = coreWith(rooms);
  const roomList = new RoomList(core);
  const cleanup = $effect.root(() => {
    void roomList.mutedRoomIds;
  });

  await roomList.start();
  await vi.waitFor(() => {
    expect(roomList.rooms).toHaveLength(3);
  });

  expect([...roomList.mutedRoomIds]).toEqual(['!muted:example.org']);
  expect(roomList.notificationOverride('!muted:example.org')).toBe('mute');
  expect(roomList.notificationOverride('!default:example.org')).toBeNull();

  cleanup();
  roomList.stop();
});

test('a room with no override follows the account default for its kind', async () => {
  const rooms = [
    room('!group:example.org'),
    room('!dm:example.org', { is_direct: true }),
    room('!loud-dm:example.org', { is_direct: true, notification_mode: 'all' }),
  ];
  const { core } = coreWith(rooms, { direct: 'mute', group: 'all' });
  const roomList = new RoomList(core);
  const cleanup = $effect.root(() => {
    void roomList.mutedRoomIds;
  });

  await roomList.start();
  await vi.waitFor(() => {
    expect([...roomList.mutedRoomIds]).toEqual(['!dm:example.org']);
  });

  cleanup();
  roomList.stop();
});
