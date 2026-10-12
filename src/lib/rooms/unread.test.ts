import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

import { withCounts } from './summary-fixtures';
import { applyBadgeMode, badgeModeFor, hasUnread, roomNotifications, roomUnread } from './unread';

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return withCounts({
    room_id: '!room:example.org',
    is_direct: false,
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    ...overrides,
  } as RoomSummary);
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

test('badge mentions mode keeps unread but drops the counted badge', () => {
  const loud = roomUnread(room({ unread: 6, notifying: 6, highlight: 1 }));
  expect(applyBadgeMode(loud, 'mentions')).toEqual({
    unread: 6,
    highlight: 1,
    marked: false,
    notifying: 0,
  });
});

test('badge quiet mode keeps only the mentions', () => {
  const loud = roomUnread(room({ unread: 6, notifying: 6, highlight: 2 }));
  expect(applyBadgeMode(loud, 'quiet')).toEqual({
    unread: 2,
    highlight: 2,
    marked: false,
    notifying: 0,
  });
  const none = roomUnread(room({ unread: 6, notifying: 6 }));
  expect(applyBadgeMode(none, 'quiet').unread).toBe(0);
});

test('badge all mode promotes quiet unread into a counted badge', () => {
  const quiet = roomUnread(room({ unread: 6, notifying: 0 }));
  expect(applyBadgeMode(quiet, 'all')).toEqual({
    unread: 6,
    highlight: 0,
    marked: false,
    notifying: 6,
  });
});

test('badge mode follows a room override before the local default', () => {
  expect(badgeModeFor({ is_direct: false }, null, { direct: 'all', group: 'mentions' })).toBe(
    'mentions'
  );
  expect(badgeModeFor({ is_direct: true }, null, { direct: 'all', group: 'mentions' })).toBe('all');
  expect(badgeModeFor({ is_direct: false }, 'all', { direct: 'all', group: 'mentions' })).toBe(
    'all'
  );
  expect(badgeModeFor({ is_direct: true }, 'mentions', { direct: 'all', group: 'mentions' })).toBe(
    'mentions'
  );
  expect(badgeModeFor({ is_direct: false }, 'mute', { direct: 'all', group: 'mentions' })).toBe(
    'mute'
  );
});
