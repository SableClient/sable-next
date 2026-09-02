import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomSummary } from '#src/generated/RoomSummary';

import { RoomList } from './room-list.svelte.js';

afterEach(() => {
  vi.restoreAllMocks();
});

test('limits concurrent notification-settings requests after room-list hydration', async () => {
  let active = 0;
  let maximumActive = 0;
  const notificationSettings = vi.fn(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { room: null, default: 'all' };
  });
  const rooms = Array.from({ length: 20 }, (_, index) => ({
    room_id: `!room-${String(index)}:example.org`,
  })) as RoomSummary[];
  const core = {
    subscribeEvents: vi.fn(() => {
      return () => {};
    }),
    commands: {
      subscribeRoomList: vi.fn(() => Promise.resolve({ subscription: 1, rooms })),
      notificationSettings,
      unsubscribe: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CoreClient;
  const roomList = new RoomList(core);

  await roomList.start();
  await vi.waitFor(() => {
    expect(notificationSettings).toHaveBeenCalledTimes(rooms.length);
  });

  expect(maximumActive).toBeLessThanOrEqual(8);
  roomList.stop();
});
