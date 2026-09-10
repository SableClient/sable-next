// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  retire: vi.fn().mockResolvedValue(undefined),
  setReadRoom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('./retire', () => ({ retireRoomAlerts: mocks.retire }));

import type { CoreClient } from '#lib/core/client.svelte.js';

import { NotificationCenter } from './notifications.svelte';

beforeEach(() => {
  mocks.retire.mockClear();
  mocks.setReadRoom.mockClear();
});

function room(unread: number): RoomSummary {
  return { room_id: '!room:example.org', unread } as RoomSummary;
}

function center(): NotificationCenter {
  const notifications = new NotificationCenter();
  notifications.start(
    {
      session: { account_id: '@me:example.org' },
      commands: { setReadRoom: mocks.setReadRoom },
      subscribeEvents: () => () => {},
    } as unknown as CoreClient,
    () => {}
  );
  return notifications;
}

test('a room read after it was unread retires its alerts', () => {
  const notifications = center();

  notifications.retireRead([room(2)]);
  expect(mocks.retire).not.toHaveBeenCalled();

  notifications.retireRead([room(0)]);
  expect(mocks.retire).toHaveBeenCalledWith('@me:example.org', '!room:example.org');
});

test('a room that was never unread retires nothing', () => {
  const notifications = center();

  notifications.retireRead([room(0)]);
  notifications.retireRead([room(0)]);

  expect(mocks.retire).not.toHaveBeenCalled();
});

test('opening a room retires its alerts and tells the core to skip it', () => {
  const notifications = center();

  notifications.readRoom('!room:example.org');

  expect(mocks.setReadRoom).toHaveBeenCalledWith('!room:example.org');
  expect(mocks.retire).toHaveBeenCalledWith('@me:example.org', '!room:example.org');
});

test('leaving a room clears the core-side gate', () => {
  const notifications = center();

  notifications.readRoom('!room:example.org');
  notifications.readRoom(null);

  expect(mocks.setReadRoom).toHaveBeenLastCalledWith(null);
});
