// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { NotificationView, RoomSummary } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  retire: vi.fn().mockResolvedValue(undefined),
  retireRead: vi.fn().mockResolvedValue(undefined),
  setReadRoom: vi.fn().mockResolvedValue(undefined),
  ackWebPusher: vi.fn().mockResolvedValue(undefined),
  watchNativePushMessages: vi.fn().mockResolvedValue(() => {}),
  sound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('#lib/platform/native-notifications.js', () => ({
  watchNativePushMessages: mocks.watchNativePushMessages,
}));
vi.mock('./retire', () => ({
  retireRoomAlerts: mocks.retire,
  retireReadAlerts: mocks.retireRead,
}));
vi.mock('./sound', () => ({ playNotificationSound: mocks.sound }));

import type { CoreClient } from '#lib/core/client.svelte.js';

import { NotificationCenter } from './notifications.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';

beforeEach(() => {
  mocks.retire.mockClear();
  mocks.retireRead.mockClear();
  mocks.setReadRoom.mockClear();
  mocks.ackWebPusher.mockClear();
  mocks.watchNativePushMessages.mockClear();
  mocks.sound.mockClear();
  preferences.systemNotifications = false;
  preferences.notificationSounds = true;
  preferences.notifyOnce = true;
  preferences.clearNotificationsOnRead = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function room(unread: number): RoomSummary {
  return {
    room_id: '!room:example.org',
    state: 'joined',
    unread,
    notifying: unread,
    highlight: 0,
    marked_unread: false,
  } as RoomSummary;
}

function center(): NotificationCenter {
  const notifications = new NotificationCenter();
  notifications.start(
    {
      session: { account_id: 'a1', user_id: '@me:example.org' },
      commands: { setReadRoom: mocks.setReadRoom, ackWebPusher: mocks.ackWebPusher },
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

test("a read push for another account retires that account's alert and not the reader's", () => {
  const notifications = center();
  notifications.readRoom('!room:example.org');
  mocks.retire.mockClear();

  const handler = mocks.watchNativePushMessages.mock.calls[0]?.[0] as
    | ((message: { message: string }) => void)
    | undefined;
  handler?.({
    message: JSON.stringify({
      notification: {
        room_id: '!room:example.org',
        user_id: '@other:example.org',
        counts: { unread: 0 },
      },
    }),
  });

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@other:example.org', '!room:example.org');
});

function readThrough(eventId: string): RoomSummary {
  return { ...room(0), latest_event: { event_id: eventId } } as RoomSummary;
}

function push(eventId: string): void {
  const handler = mocks.watchNativePushMessages.mock.calls[0]?.[0] as
    | ((message: { message: string }) => void)
    | undefined;
  handler?.({
    message: JSON.stringify({
      notification: { room_id: '!room:example.org', event_id: eventId, counts: { unread: 1 } },
    }),
  });
}

test('an Android push for a message already read on another device is retired', () => {
  const notifications = center();
  notifications.retireRead([readThrough('$new')]);
  mocks.retire.mockClear();

  push('$new');

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', '!room:example.org');
});

test('an Android push that outruns its read message is retired once the message syncs', () => {
  const notifications = center();
  notifications.retireRead([readThrough('$old')]);
  mocks.retire.mockClear();

  push('$new');
  notifications.retireRead([readThrough('$old')]);
  expect(mocks.retire).not.toHaveBeenCalled();

  notifications.retireRead([readThrough('$new')]);
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', '!room:example.org');
});

test('an Android push for an unread message stands until the room is read', () => {
  const notifications = center();
  notifications.retireRead([readThrough('$old')]);
  mocks.retire.mockClear();

  push('$new');
  notifications.retireRead([{ ...readThrough('$new'), unread: 1, notifying: 1 }]);
  expect(mocks.retire).not.toHaveBeenCalled();

  notifications.retireRead([readThrough('$new')]);
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', '!room:example.org');
});

test('a native MSC4174 validation push without native handling is acknowledged without an alert', async () => {
  center();
  const handler = mocks.watchNativePushMessages.mock.calls[0]?.[0] as
    | ((message: { message: string }) => void)
    | undefined;

  handler?.({ message: JSON.stringify({ app_id: 'moe.sable.webpush', ack_token: 'token' }) });

  await vi.waitFor(() => {
    expect(mocks.ackWebPusher).toHaveBeenCalledWith('moe.sable.webpush', 'token');
  });
  expect(mocks.retire).not.toHaveBeenCalled();
});

test('native activation work is not acknowledged a second time by JavaScript', () => {
  center();
  const handler = mocks.watchNativePushMessages.mock.calls[0]?.[0] as
    | ((message: { message: string; nativeActivation: boolean }) => void)
    | undefined;
  handler?.({
    message: JSON.stringify({ app_id: 'moe.sable.webpush', ack_token: 'token' }),
    nativeActivation: true,
  });
  expect(mocks.ackWebPusher).not.toHaveBeenCalled();
  expect(mocks.retire).not.toHaveBeenCalled();
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
  preferences.systemNotifications = true;
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

function message(eventId: string): NotificationView {
  return { ...invite(), event_id: eventId, body: 'Hello', noisy: true };
}

test('a second message in a room with a standing alert does not sound again', () => {
  const notifications = center();

  notifications.present(message('$one'));
  expect(mocks.sound).toHaveBeenCalledTimes(1);

  notifications.present(message('$two'));
  expect(mocks.sound).toHaveBeenCalledTimes(1);

  notifications.retireRead([room(0)]);
  notifications.present(message('$three'));
  expect(mocks.sound).toHaveBeenCalledTimes(2);
});

test('reading a room re-arms its sound while read alerts are left standing', () => {
  preferences.clearNotificationsOnRead = false;
  const notifications = center();

  notifications.present(message('$one'));
  notifications.readRoom('!room:example.org');
  notifications.readRoom(null);
  notifications.present(message('$two'));
  expect(mocks.sound).toHaveBeenCalledTimes(2);

  notifications.retireRead([room(0)]);
  notifications.present(message('$three'));
  expect(mocks.sound).toHaveBeenCalledTimes(3);
  expect(mocks.retire).not.toHaveBeenCalled();
});

test('a mention sounds even in a room with a standing alert', () => {
  const notifications = center();

  notifications.present(message('$one'));
  notifications.present({ ...message('$two'), mention: true });

  expect(mocks.sound).toHaveBeenCalledTimes(2);
});

test('every message sounds while only notifying once is off', () => {
  preferences.notifyOnce = false;
  const notifications = center();

  notifications.present(message('$one'));
  notifications.present(message('$two'));

  expect(mocks.sound).toHaveBeenCalledTimes(2);
});

test('alerts posted while the app was away are retired once their room reads as read', () => {
  vi.useFakeTimers();
  const notifications = center();

  notifications.retireRead([room(0)]);
  notifications.retireRead([room(0), { ...room(3), room_id: '!busy:example.org' }]);
  expect(mocks.retireRead).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1000);
  expect(mocks.retireRead).toHaveBeenCalledExactlyOnceWith('@me:example.org', [
    '!room:example.org',
  ]);
});

test('posted alerts are left alone while read alerts stay standing', () => {
  vi.useFakeTimers();
  preferences.clearNotificationsOnRead = false;
  const notifications = center();

  notifications.retireRead([room(0)]);
  vi.advanceTimersByTime(1000);

  expect(mocks.retireRead).not.toHaveBeenCalled();
});
