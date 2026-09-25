import { expect, test } from 'vitest';

import type { NotificationModeView, RoomSummary } from '#src/generated/protocol';

import { hasUnread, roomNotifications, roomUnread } from './unread';

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: '!room:example.org',
    is_direct: false,
    is_space: false,
    state: 'joined',
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    ...overrides,
  } as RoomSummary;
}

test('all-messages mode counts every unread message', () => {
  expect(roomUnread(room({ unread: 7, notifying: 7, highlight: 2 }), 'all')).toEqual({
    unread: 7,
    highlight: 2,
    marked: false,
    notifying: 7,
  });
});

test('a mentions-only room still reads as unread, because it is', () => {
  expect(roomUnread(room({ unread: 7, highlight: 0 }), 'mentions')).toEqual({
    unread: 7,
    highlight: 0,
    marked: false,
    notifying: 0,
  });
});

test('a mentions-only room notifies for its mentions alone', () => {
  expect(roomNotifications(room({ unread: 7, notifying: 2, highlight: 2 }), 'mentions')).toEqual({
    unread: 2,
    highlight: 2,
    marked: false,
  });
  expect(roomNotifications(room({ unread: 7, highlight: 0 }), 'mentions').unread).toBe(0);
});

test('what notified is what the push rules notified on, whatever the mode', () => {
  expect(roomNotifications(room({ unread: 7, notifying: 1 }), 'mentions').unread).toBe(1);
  expect(roomNotifications(room({ unread: 7, notifying: 3 }), 'all').unread).toBe(3);
  expect(roomNotifications(room({ unread: 7, notifying: 3 }), null).unread).toBe(3);
});

test('a muted room neither reads as unread nor notifies', () => {
  const summary = room({ unread: 7, highlight: 2 });

  expect(hasUnread(roomUnread(summary, 'mute'))).toBe(false);
  expect(hasUnread(roomNotifications(summary, 'mute'))).toBe(false);
});

test('a muted room counts nothing', () => {
  expect(roomUnread(room({ unread: 7, highlight: 2 }), 'mute')).toEqual({
    unread: 0,
    highlight: 0,
    marked: false,
    notifying: 0,
  });
});

test('an unresolved mode still reads unread messages as unread', () => {
  const summary = room({ unread: 7, highlight: 0 });

  expect(roomUnread(summary, null).unread).toBe(7);
  expect(hasUnread(roomUnread(summary, null))).toBe(true);
});

test('a mention the local count has not caught up with still counts', () => {
  expect(roomUnread(room({ unread: 0, highlight: 3 }), 'all').unread).toBe(3);
});

test('marking a room unread survives every mode, including mute', () => {
  const modes: (NotificationModeView | null)[] = ['all', 'mentions', 'mute', null];

  for (const mode of modes) {
    expect(hasUnread(roomUnread(room({ marked_unread: true }), mode))).toBe(true);
  }
});

test('an empty room has nothing to report', () => {
  expect(hasUnread(roomUnread(room(), 'all'))).toBe(false);
  expect(hasUnread(roomUnread(room(), null))).toBe(false);
});

test('a summary missing its counts reads as nothing, not as NaN', () => {
  const partial = { room_id: '!old:example.org' } as RoomSummary;

  expect(roomUnread(partial, 'all').unread).toBe(0);
  expect(hasUnread(roomUnread(partial, 'all'))).toBe(false);
  expect(hasUnread(roomNotifications(partial, 'mentions'))).toBe(false);
});

test('a mentions-only room retires its alert once the mention is read', () => {
  const pinged = room({ unread: 5, notifying: 1, highlight: 1 });
  const read = room({ unread: 5, highlight: 0 });

  expect(hasUnread(roomNotifications(pinged, 'mentions'))).toBe(true);
  expect(hasUnread(roomNotifications(read, 'mentions'))).toBe(false);
  expect(hasUnread(roomUnread(read, 'mentions'))).toBe(true);
});

test('the agreed badge matrix, written out', () => {
  const cases: {
    mode: NotificationModeView | null;
    shape: Partial<RoomSummary>;
    green: boolean;
    inbox: number;
  }[] = [
    { mode: 'all', shape: { unread: 6, notifying: 6 }, green: true, inbox: 6 },
    { mode: 'all', shape: { unread: 9, notifying: 9, highlight: 2 }, green: true, inbox: 9 },
    { mode: 'all', shape: { unread: 6 }, green: false, inbox: 0 },
    { mode: 'mentions', shape: { unread: 6 }, green: false, inbox: 0 },
    { mode: 'mentions', shape: { unread: 9, notifying: 2, highlight: 2 }, green: true, inbox: 2 },
    { mode: 'mentions', shape: { unread: 9, notifying: 1 }, green: true, inbox: 1 },
    { mode: 'mute', shape: { unread: 9, notifying: 9, highlight: 2 }, green: false, inbox: 0 },
    { mode: null, shape: { unread: 6, notifying: 6 }, green: true, inbox: 6 },
    { mode: 'mute', shape: { marked_unread: true }, green: false, inbox: 0 },
  ];

  for (const { mode, shape, green, inbox } of cases) {
    const label = `${String(mode)} ${JSON.stringify(shape)}`;
    const notifying = roomNotifications(room(shape), mode).unread;

    expect(notifying, label).toBe(inbox);
    expect(notifying > 0, label).toBe(green);
  }
});

test('an unread room the mode silenced still reads as unread', () => {
  expect(roomUnread(room({ unread: 6 }), 'mentions').unread).toBe(6);
  expect(roomNotifications(room({ unread: 6 }), 'mentions').unread).toBe(0);
});

test('an unread count carries how much of it notified', () => {
  expect(roomUnread(room({ unread: 6, notifying: 6 }), 'all').notifying).toBe(6);
  expect(roomUnread(room({ unread: 6 }), 'mentions').notifying).toBe(0);
  expect(roomUnread(room({ unread: 9, notifying: 2, highlight: 2 }), 'mentions').notifying).toBe(2);
  expect(roomUnread(room({ unread: 9, notifying: 2, highlight: 2 }), 'mute').notifying).toBe(0);
});
