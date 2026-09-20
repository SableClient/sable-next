import { expect, test } from 'vitest';

import type { NotificationModeView, RoomSummary } from '#src/generated/protocol';

import { hasUnread, roomUnread } from './unread';

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: '!room:example.org',
    is_direct: false,
    is_space: false,
    state: 'joined',
    unread: 0,
    highlight: 0,
    marked_unread: false,
    ...overrides,
  } as RoomSummary;
}

test('all-messages mode counts every unread message', () => {
  expect(roomUnread(room({ unread: 7, highlight: 2 }), 'all')).toEqual({
    unread: 7,
    highlight: 2,
    marked: false,
  });
});

test('mentions-only mode counts mentions and discards the rest', () => {
  expect(roomUnread(room({ unread: 7, highlight: 2 }), 'mentions')).toEqual({
    unread: 2,
    highlight: 2,
    marked: false,
  });
});

test('a muted room counts nothing', () => {
  expect(roomUnread(room({ unread: 7, highlight: 2 }), 'mute')).toEqual({
    unread: 0,
    highlight: 0,
    marked: false,
  });
});

test('an unresolved mode counts as all messages, which is the server default', () => {
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
