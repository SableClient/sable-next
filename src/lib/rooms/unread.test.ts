import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { roomView } from '#lib/test-support/room-views.js';

import { hasUnread, roomNotifications, roomUnread } from './unread';

function room(overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return roomView(overrides);
}

test('the inbox counts what notified, not what is unread', () => {
  const summary = room({ unread: 9, notifying: 2, highlight: 1, marked_unread: true });

  expect(roomNotifications(summary)).toEqual({ unread: 2, highlight: 1, marked: true });
  expect(roomUnread(summary).unread).toBe(9);
});

test('a muted room reports nothing but its manual mark', () => {
  const muted = room({
    unread: 7,
    highlight: 2,
    marked_unread: true,
    notification: { room: 'mute', default: 'all' },
  });

  expect(roomNotifications(muted)).toEqual({ unread: 0, highlight: 0, marked: true });
  expect(hasUnread(roomUnread(muted))).toBe(true);
});
