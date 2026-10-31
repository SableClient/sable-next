// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent, NotificationView, RoomListItemView } from '#src/generated/protocol';

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
import { withCounts } from '#lib/rooms/summary-fixtures.js';

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

function room(unread: number, roomId = '!room:example.org'): RoomListItemView {
  return withCounts({
    room_id: roomId,
    state: 'joined',
    unread,
    notifying: unread,
    highlight: 0,
    marked_unread: false,
  } as RoomListItemView);
}

function center(
  open: (roomId: string, eventId: string | null) => void = () => {},
  subscribeEvents: (listener: (event: CoreEvent) => void) => () => void = () => () => {}
): NotificationCenter {
  const notifications = new NotificationCenter();
  notifications.start(
    {
      session: { account_id: 'a1', user_id: '@me:example.org' },
      rpc: {
        push: { ackWebPusher: mocks.ackWebPusher },
        session: { setReadRoom: mocks.setReadRoom },
      },
      subscribeEvents,
    } as unknown as CoreClient,
    open
  );
  return notifications;
}

test('calls post silent system banners even in the open room and close on cancellation or expiry', async () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const show = vi.fn();
  class BrowserNotification extends EventTarget {
    static permission = 'granted';
    constructor(title: string, options: NotificationOptions) {
      super();
      show(title, options);
    }
    close = close;
  }
  vi.stubGlobal('Notification', BrowserNotification);
  preferences.systemNotifications = true;
  preferences.notificationContent = true;
  let emit!: (event: CoreEvent) => void;
  const notifications = center(
    () => {},
    (listener) => {
      emit = listener;
      return () => {};
    }
  );
  notifications.readRoom('!room:example.org');
  const incoming: CoreEvent = {
    type: 'incoming_call',
    room_id: '!room:example.org',
    notification_event_id: '$call',
    sender: '@bob:example.org',
    sender_name: 'Bob',
    room_name: 'Room',
    ring: true,
    has_video: false,
    expires_at_ms: Date.now() + 30000,
  };
  emit(incoming);
  emit(incoming);
  expect(show).toHaveBeenCalledExactlyOnceWith(
    'Bob',
    expect.objectContaining({
      body: 'Incoming call',
      silent: true,
      tag: '@me:example.org !room:example.org:$call',
    })
  );
  expect(mocks.sound).not.toHaveBeenCalled();
  emit({ type: 'incoming_call_ended', notification_event_id: '$call' });
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  emit({ ...incoming, notification_event_id: '$next' });
  await vi.advanceTimersByTimeAsync(30000);
  expect(close).toHaveBeenCalledTimes(2);
  notifications.stop();
});

test('startup removes expired call banners left by background push', async () => {
  const expired = { data: { call: true, callExpiresAtMs: Date.now() - 1 }, close: vi.fn() };
  const active = { data: { call: true, callExpiresAtMs: Date.now() + 90000 }, close: vi.fn() };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: () =>
        Promise.resolve({ getNotifications: () => Promise.resolve([expired, active]) }),
    },
  });
  const notifications = center();
  await vi.waitFor(() => {
    expect(expired.close).toHaveBeenCalledOnce();
  });
  expect(active.close).not.toHaveBeenCalled();
  notifications.stop();
});

test('a room read after it was unread retires its alerts', () => {
  const notifications = center();

  notifications.retireRead([room(2)]);
  expect(mocks.retire).not.toHaveBeenCalled();

  notifications.retireRead([room(0)]);
  expect(mocks.retire).toHaveBeenCalledWith('@me:example.org', ['!room:example.org']);
});

test('a room already read on another device retires a cold notification', () => {
  const notifications = center();

  notifications.retireRead([room(0)]);
  notifications.retireRead([room(0)]);

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', ['!room:example.org']);
});

test('batched posted alerts retain rooms read before the timer fires', () => {
  vi.useFakeTimers();
  const notifications = center();

  notifications.retireRead([room(0, '!one:example.org')]);
  notifications.retireRead([room(0, '!two:example.org')]);
  mocks.retireRead.mockClear();

  vi.advanceTimersByTime(1000);

  expect(mocks.retireRead).toHaveBeenCalledExactlyOnceWith('@me:example.org', [
    '!one:example.org',
    '!two:example.org',
  ]);
});

test('opening a room retires its alerts and tells the core to skip it', () => {
  const notifications = center();

  notifications.readRoom('!room:example.org');

  expect(mocks.setReadRoom).toHaveBeenCalledWith({ room_id: '!room:example.org' });
  expect(mocks.retire).toHaveBeenCalledWith('@me:example.org', ['!room:example.org']);
});

test('leaving a room clears the core-side gate', () => {
  const notifications = center();

  notifications.readRoom('!room:example.org');
  notifications.readRoom(null);

  expect(mocks.setReadRoom).toHaveBeenLastCalledWith({ room_id: null });
});

test('an Android push for the room being read is immediately retired', () => {
  const notifications = center();
  notifications.readRoom('!room:example.org');
  mocks.retire.mockClear();

  const handler = mocks.watchNativePushMessages.mock.calls[0]?.[0] as
    | ((message: { message: string }) => void)
    | undefined;
  handler?.({ message: JSON.stringify({ notification: { room_id: '!room:example.org' } }) });

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', ['!room:example.org']);
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

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@other:example.org', ['!room:example.org']);
});

function readThrough(eventId: string): RoomListItemView {
  return { ...room(0), latest_event: { event_id: eventId } } as RoomListItemView;
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

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', ['!room:example.org']);
});

test('an Android push that outruns its read message is retired once the message syncs', () => {
  const notifications = center();
  notifications.retireRead([readThrough('$old')]);
  mocks.retire.mockClear();

  push('$new');
  notifications.retireRead([readThrough('$old')]);
  expect(mocks.retire).not.toHaveBeenCalled();

  notifications.retireRead([readThrough('$new')]);
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', ['!room:example.org']);
});

test('an Android push for an unread message stands until the room is read', () => {
  const notifications = center();
  notifications.retireRead([readThrough('$old')]);
  mocks.retire.mockClear();

  push('$new');
  notifications.retireRead([withCounts({ ...readThrough('$new'), unread: 1, notifying: 1 })]);
  expect(mocks.retire).not.toHaveBeenCalled();

  notifications.retireRead([readThrough('$new')]);
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', ['!room:example.org']);
});

test('a native MSC4174 validation push without native handling is acknowledged without an alert', async () => {
  center();
  const handler = mocks.watchNativePushMessages.mock.calls[0]?.[0] as
    | ((message: { message: string }) => void)
    | undefined;

  handler?.({ message: JSON.stringify({ app_id: 'moe.sable.webpush', ack_token: 'token' }) });

  await vi.waitFor(() => {
    expect(mocks.ackWebPusher).toHaveBeenCalledWith({
      app_id: 'moe.sable.webpush',
      ack_token: 'token',
    });
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
      expect.objectContaining({ body: 'Alice: Hello everyone' })
    );
  });
  expect(show.mock.calls[0]?.[1]).not.toHaveProperty('tag');
  notifications.stop();
});

test('each message posts its own banner instead of replacing a room alert', async () => {
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

  for (const body of ['first', 'second']) {
    notifications.present({
      ...invite(),
      event_id: `$${body}`,
      is_direct: false,
      room_name: 'General',
      body,
    });
  }

  await vi.waitFor(() => {
    expect(show).toHaveBeenCalledTimes(2);
  });
  expect(show.mock.calls.map((call) => (call[1] as NotificationOptions).body)).toEqual([
    'Alice: first',
    'Alice: second',
  ]);
  expect(show.mock.calls[0]?.[1]).not.toHaveProperty('tag');
  expect(show.mock.calls[1]?.[1]).not.toHaveProperty('tag');
  notifications.stop();
});

test('reading a room closes every banner it posted', async () => {
  const show = vi.fn();
  const close = vi.fn();
  class BrowserNotification {
    static permission = 'granted';
    constructor(title: string, options: NotificationOptions) {
      show(title, options);
    }
    addEventListener() {}
    close = close;
  }
  vi.stubGlobal('Notification', BrowserNotification);
  preferences.systemNotifications = true;
  preferences.notificationContent = true;
  const notifications = center();

  notifications.present(message('$one'));
  notifications.present(message('$two'));
  await vi.waitFor(() => {
    expect(show).toHaveBeenCalledTimes(2);
  });

  notifications.retireRead([room(0)]);
  expect(close).toHaveBeenCalledTimes(2);
  notifications.stop();
});

test('a browser without the Notification constructor shows through the service worker', async () => {
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const AndroidNotification = Object.assign(
    function () {
      throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
    },
    { permission: 'granted' }
  );
  vi.stubGlobal('Notification', AndroidNotification);
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: () => Promise.resolve({ showNotification }) },
  });
  preferences.systemNotifications = true;
  preferences.notificationContent = true;
  const notifications = center();

  notifications.present({ ...invite(), event_id: '$message', room_name: 'General' });

  await vi.waitFor(() => {
    expect(showNotification).toHaveBeenCalledWith(
      'General',
      expect.objectContaining({
        data: { roomId: '!room:example.org', userId: '@me:example.org', eventId: '$message' },
      })
    );
  });
  expect(showNotification.mock.calls[0]?.[1]).not.toHaveProperty('tag');
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
    expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', ['!room:example.org']);
  }
);

test('rejecting an invite removes its entry from the SDK non-left room list', () => {
  const notifications = center();
  notifications.present(invite());
  notifications.retireRead([{ ...room(0), state: 'invited' }]);
  notifications.retireRead([]);
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith('@me:example.org', ['!room:example.org']);
});

function message(eventId: string): NotificationView {
  return { ...invite(), event_id: eventId, body: 'Hello', noisy: true };
}

test.each(['browser', 'electron'])(
  'clicking a %s notification opens its room and message',
  async (platform) => {
    const shown: BrowserNotification[] = [];
    class BrowserNotification extends EventTarget {
      static permission = 'granted';
      close = vi.fn();
      constructor() {
        super();
        shown.push(this);
      }
    }
    vi.stubGlobal('Notification', BrowserNotification);
    const focus = vi.fn();
    const showWindow = vi.fn();
    vi.stubGlobal('focus', focus);
    if (platform === 'electron')
      vi.stubGlobal('sableElectron', { showWindow, requestAttention: vi.fn() });
    preferences.systemNotifications = true;
    const open = vi.fn();
    const notifications = center(open);

    notifications.present(message('$one'));
    notifications.present({ ...message('$two'), room_id: '!other:example.org' });
    await vi.waitFor(() => {
      expect(shown).toHaveLength(2);
    });

    shown[1].dispatchEvent(new Event('click'));

    expect(showWindow).toHaveBeenCalledTimes(platform === 'electron' ? 1 : 0);
    expect(focus).toHaveBeenCalledTimes(platform === 'browser' ? 1 : 0);
    expect(shown[1].close).toHaveBeenCalledOnce();
    expect(shown[0].close).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledExactlyOnceWith('!other:example.org', '$two');
    notifications.stop();
  }
);

test('a message whose rule rings sounds every time, alert standing or not', () => {
  const notifications = center();

  notifications.present(message('$one'));
  notifications.present(message('$two'));
  notifications.present({ ...message('$three'), noisy: false });

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

test('a first sweep retires every read room in one call', () => {
  const notifications = center();
  const rooms = Array.from({ length: 500 }, (_unused, index) => ({
    ...room(0),
    room_id: `!read${index}:example.org`,
  }));

  notifications.retireRead(rooms);

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(
    '@me:example.org',
    rooms.map((read) => read.room_id)
  );
});
