import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { withCounts } from './summary-fixtures';
import { hasUnread, roomNotifications, roomUnread } from './unread';

function room(overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return withCounts({
    room_id: '!room:example.org',
    is_direct: false,
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    ...overrides,
  } as RoomListItemView);
}

test('the inbox counts what notified, not what is unread', () => {
  const summary = room({ unread: 9, notifying: 2, highlight: 1, marked_unread: true });

  expect(roomNotifications(summary)).toEqual({
    unread: 2,
    highlight: 1,
    marked: true,
    notifying: 2,
  });
  expect(roomUnread(summary).unread).toBe(9);
});

test('a muted room reports nothing but its manual mark', () => {
  const muted = room({
    unread: 7,
    highlight: 2,
    marked_unread: true,
    notification: { room: 'mute', default: 'all' },
  });

  expect(roomNotifications(muted)).toEqual({ unread: 0, highlight: 0, marked: true, notifying: 0 });
  expect(hasUnread(roomUnread(muted))).toBe(true);
});
