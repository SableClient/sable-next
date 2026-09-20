// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { NotificationView, RoomSummary } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  retire: vi.fn().mockResolvedValue(undefined),
  setReadRoom: vi.fn().mockResolvedValue(undefined),
  watchNativePushMessages: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('#lib/platform/native-notifications.js', () => ({
  watchNativePushMessages: mocks.watchNativePushMessages,
}));
vi.mock('./retire', () => ({ retireRoomAlerts: mocks.retire }));

import type { CoreClient } from '#lib/core/client.svelte.js';

import { NotificationCenter } from './notifications.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';

beforeEach(() => {
  mocks.retire.mockClear();
  mocks.setReadRoom.mockClear();
  mocks.watchNativePushMessages.mockClear();
  preferences.desktopNotifications = false;
  preferences.clearNotificationsOnRead = true;
});

afterEach(() => vi.unstubAllGlobals());

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

test('a room already read on another device retires a cold notification', () => {
  const notifications = center();

  notifications.retireRead([room(0)]);
  notifications.retireRead([room(0)]);

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', '!room:example.org');
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

test('an Android push for the room being read is immediately retired', () => {
  const notifications = center();
  notifications.readRoom('!room:example.org');
  mocks.retire.mockClear();

  const handler = mocks.watchNativePushMessages.mock.calls[0]?.[0] as
    | ((message: { message: string }) => void)
    | undefined;
  handler?.({ message: JSON.stringify({ notification: { room_id: '!room:example.org' } }) });

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', '!room:example.org');
});

function invite(): NotificationView {
  return {
    user_id: '@me:example.org',
    room_id: '!room:example.org',
    event_id: null,
    room_name: 'Alice',
    room_avatar_url: null,
    is_direct: true,
    encrypted: false,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar_url: null,
    body: 'invited you',
    mention: false,
    noisy: false,
  };
}

test('shows ordinary channel messages when browser notifications are enabled', async () => {
  const show = vi.fn();
  class BrowserNotification {
    static permission = 'granted';
    constructor(title: string, options: NotificationOptions) {
      show(title, options);
    }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('Notification', BrowserNotification);
  preferences.desktopNotifications = true;
  preferences.notificationContent = true;
  const notifications = center();
  notifications.present({
    ...invite(),
    event_id: '$message',
    is_direct: false,
    room_name: 'General',
    body: 'Hello everyone',
  });
  await vi.waitFor(() => {
    expect(show).toHaveBeenCalledWith(
      'General',
      expect.objectContaining({
        body: 'Alice: Hello everyone',
        tag: '@me:example.org !room:example.org',
      })
    );
  });
  notifications.stop();
});

test.each(['joined', 'left', 'banned'] as const)(
  'an invite survives unrelated updates until its membership becomes %s',
  (state) => {
    const notifications = center();
    notifications.present(invite());
    notifications.retireRead([]);
    notifications.retireRead([{ ...room(0), state: 'invited' }]);
    notifications.retireRead([
      { ...room(0), state: 'invited' },
      { ...room(2), room_id: '!other:example.org', state: 'joined' },
    ]);
    expect(mocks.retire).not.toHaveBeenCalled();

    notifications.retireRead([{ ...room(0), state }]);
    expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', '!room:example.org');
  }
);

test('rejecting an invite removes its entry from the SDK non-left room list', () => {
  const notifications = center();
  notifications.present(invite());
  notifications.retireRead([{ ...room(0), state: 'invited' }]);
  notifications.retireRead([]);
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', '!room:example.org');
});
