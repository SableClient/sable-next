import { expect, test } from 'vitest';

import type { BookmarkView, RoomSummary } from '#src/generated/protocol';

import { applyBadgeMode, badgeModeFor, roomUnread, type RoomUnread } from '#lib/rooms/unread.js';

import {
  backfillSignal,
  countInvites,
  countNotifications,
  filteredBookmarks,
  formatCompactTimestamp,
  hasMarkedUnread,
  inviter,
  notificationCount,
  notifications,
  parseFilter,
  pendingInvites,
  senderName,
} from './inbox';

function room(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    room_id: '!room:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: false,
    is_tombstoned: false,
    is_voice: false,
    call_participants: [],
    room_type: null,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  };
}

function badgeFor(
  override: (roomId: string) => 'all' | 'mentions' | 'mute' | null = () => null
): RoomUnread {
  return (summary) =>
    applyBadgeMode(
      roomUnread(summary, override(summary.room_id) ?? 'all'),
      badgeModeFor(summary, override(summary.room_id), {
        direct: 'all',
        group: 'mentions',
      })
    );
}

test('an unknown filter falls back to showing everything', () => {
  expect(parseFilter(null)).toBe('all');
  expect(parseFilter('unread')).toBe('all');
  expect(parseFilter('mentions')).toBe('mentions');
});

test('the inbox badge counts DMs and mentions, not ordinary room messages', () => {
  const rooms = [
    room({ room_id: '!chat', is_direct: true, unread: 3, notifying: 3 }),
    room({ room_id: '!quiet-room', unread: 7, notifying: 7 }),
    room({ room_id: '!loud-room', unread: 7, notifying: 7, highlight: 2 }),
  ];
  const unreadFor = badgeFor();

  expect(countNotifications(rooms, unreadFor)).toBe(5);
  expect(notifications(rooms, 'all', unreadFor).map((each) => each.room_id)).toEqual([
    '!chat',
    '!quiet-room',
    '!loud-room',
  ]);
  expect(notifications(rooms, 'mentions', unreadFor).map((each) => each.room_id)).toEqual([
    '!loud-room',
  ]);
  expect(notifications(rooms, 'direct', unreadFor).map((each) => each.room_id)).toEqual(['!chat']);
});

test('rooms set to badge every message also count toward the inbox badge', () => {
  const rooms = [
    room({ room_id: '!chat', is_direct: true, unread: 3, notifying: 3 }),
    room({ room_id: '!channel', unread: 7, notifying: 7 }),
  ];
  const unreadFor: RoomUnread = (summary) =>
    applyBadgeMode(
      roomUnread(summary, 'all'),
      badgeModeFor(summary, null, { direct: 'all', group: 'all' })
    );

  expect(countNotifications(rooms, unreadFor)).toBe(10);
});

test('a muted room does not contribute ordinary unread or mentions to the badge', () => {
  const rooms = [
    room({ room_id: '!mentions', unread: 7, notifying: 2, highlight: 2 }),
    room({ room_id: '!dm', is_direct: true, unread: 3, notifying: 3 }),
    room({ room_id: '!muted', unread: 4, notifying: 4, highlight: 1 }),
  ];
  const unreadFor = badgeFor((roomId) => (roomId === '!muted' ? 'mute' : null));

  expect(countNotifications(rooms, unreadFor)).toBe(5);
  expect(notifications(rooms, 'mentions', unreadFor).map((each) => each.room_id)).toEqual([
    '!mentions',
  ]);
  expect(notifications(rooms, 'direct', unreadFor).map((each) => each.room_id)).toEqual(['!dm']);
});

test('filters narrow to mentions or to DMs', () => {
  const rooms = [
    room({ room_id: '!chat', is_direct: true, unread: 1, notifying: 1 }),
    room({ room_id: '!mention', highlight: 1 }),
  ];
  const unreadFor = badgeFor();

  expect(notifications(rooms, 'direct', unreadFor).map((each) => each.room_id)).toEqual(['!chat']);
  expect(notifications(rooms, 'mentions', unreadFor).map((each) => each.room_id)).toEqual([
    '!mention',
  ]);
});

test('a space never notifies, and neither does a room we have left', () => {
  const rooms = [
    room({ room_id: '!space', is_space: true, highlight: 4 }),
    room({ room_id: '!left', state: 'left', highlight: 4 }),
  ];

  expect(notifications(rooms, 'all')).toEqual([]);
  expect(countNotifications(rooms)).toBe(0);
});

test('notifications are ordered by the latest event, undated last', () => {
  const dated = (id: string, timestamp: number | null): RoomSummary =>
    room({
      room_id: id,
      highlight: 1,
      latest_event:
        timestamp === null
          ? null
          : { sender: null, body: 'hi', timestamp, sending: false, event_id: null },
    });

  const ordered = notifications(
    [dated('!old', 10), dated('!none', null), dated('!new', 20)],
    'all'
  );
  expect(ordered.map((each) => each.room_id)).toEqual(['!new', '!old', '!none']);
});

test('notificationCount prefers the counted badge over the raw unread total', () => {
  expect(notificationCount({ unread: 9, highlight: 2, notifying: 2 })).toBe(2);
  expect(notificationCount({ unread: 9, highlight: 0, notifying: 0 })).toBe(0);
  expect(notificationCount({ unread: 3, highlight: 0, notifying: 3 })).toBe(3);
});

test('invites are counted separately from notifications', () => {
  const rooms = [
    room({ room_id: '!a', state: 'invited' }),
    room({ room_id: '!b', state: 'joined', highlight: 1 }),
    room({ room_id: '!c', state: 'invited' }),
  ];
  expect(countInvites(rooms)).toBe(2);
  expect(pendingInvites(rooms).map((each) => each.room_id)).toEqual(['!a', '!c']);
});

test('an invite without a sender still lists', () => {
  expect(inviter(room({ state: 'invited' }))).toBeNull();
  expect(
    inviter(
      room({
        state: 'invited',
        latest_event: { sender: '@a:x', body: null, timestamp: 1, sending: false, event_id: null },
      })
    )
  ).toBe('@a:x');
});

test('sender names drop the homeserver', () => {
  expect(senderName('@alice:example.org')).toBe('alice');
  expect(senderName('alice')).toBe('alice');
});

test('bookmark search matches room, sender and preview', () => {
  const bookmarks = [
    {
      bookmark_id: 'bmk_room',
      room_id: '!a',
      room_name: 'Ops',
      event_id: '$1',
      sender: '@alice:example.org',
      body_preview: 'shipped',
      bookmarked_ts: 3,
    },
    {
      bookmark_id: 'bmk_sender',
      room_id: '!b',
      room_name: 'Chat',
      event_id: '$2',
      sender: '@bob:example.org',
      body_preview: 'hello',
      bookmarked_ts: 2,
    },
    {
      bookmark_id: 'bmk_preview',
      room_id: '!c',
      room_name: 'Lab',
      event_id: '$3',
      sender: null,
      body_preview: 'deploy friday',
      bookmarked_ts: 4,
    },
    {
      bookmark_id: 'bmk_other',
      room_id: '!d',
      room_name: 'Misc',
      event_id: '$4',
      sender: '@carol:example.org',
      body_preview: 'later',
      bookmarked_ts: 1,
    },
  ] as BookmarkView[];

  expect(filteredBookmarks(bookmarks, 'ops').map((each) => each.bookmark_id)).toEqual(['bmk_room']);
  expect(filteredBookmarks(bookmarks, 'bob').map((each) => each.bookmark_id)).toEqual([
    'bmk_sender',
  ]);
  expect(filteredBookmarks(bookmarks, 'deploy').map((each) => each.bookmark_id)).toEqual([
    'bmk_preview',
  ]);
  expect(filteredBookmarks(bookmarks, '').map((each) => each.bookmark_id)).toHaveLength(4);
});

test('a hand-marked room reaches the inbox with no count of its own', () => {
  const marked = room({ room_id: '!marked', marked_unread: true });
  const quiet = room({ room_id: '!quiet' });

  expect(notifications([marked, quiet], 'all').map((entry) => entry.room_id)).toEqual(['!marked']);
  expect(countNotifications([marked])).toBe(0);
  expect(hasMarkedUnread([marked])).toBe(true);
  expect(hasMarkedUnread([quiet])).toBe(false);
});

test('a marked direct chat shows under the direct filter', () => {
  const marked = room({ room_id: '!dm', is_direct: true, marked_unread: true });

  expect(notifications([marked], 'direct').map((entry) => entry.room_id)).toEqual(['!dm']);
  expect(notifications([marked], 'mentions')).toEqual([]);
});

test('a channel whose mode has not loaded yet still shows unread in All, but not the badge', () => {
  const channel = room({ room_id: '!channel', unread: 4, notifying: 4 });
  const unreadFor = badgeFor();

  expect(notifications([channel], 'all', unreadFor).map((entry) => entry.room_id)).toEqual([
    '!channel',
  ]);
  expect(countNotifications([channel], unreadFor)).toBe(0);
});

test('a muted room that was marked unread by hand still reaches the inbox', () => {
  const marked = room({ room_id: '!muted', unread: 9, marked_unread: true });
  const unreadFor = badgeFor(() => 'mute');

  expect(notifications([marked], 'all', unreadFor).map((entry) => entry.room_id)).toEqual([
    '!muted',
  ]);
  expect(countNotifications([marked], unreadFor)).toBe(0);
  expect(notifications([marked], 'mentions', unreadFor)).toEqual([]);
});

test('compact timestamps shrink with age', () => {
  const now = new Date(2026, 8, 23, 12, 0).getTime();

  expect(formatCompactTimestamp(new Date(2026, 8, 23, 9, 5).getTime(), now)).toMatch(/9|09/);
  expect(formatCompactTimestamp(new Date(2026, 8, 20, 9, 5).getTime(), now)).not.toMatch(/\d/);
  expect(formatCompactTimestamp(new Date(2026, 3, 2).getTime(), now)).not.toMatch(/2026/);
  expect(formatCompactTimestamp(new Date(2023, 10, 14).getTime(), now)).toMatch(/2023/);
});

test('only a room with notifications moves the backfill signal', () => {
  const latest = (eventId: string) => ({ event_id: eventId }) as RoomSummary['latest_event'];
  const quiet = (eventId: string) =>
    room({ room_id: '!quiet:example.org', latest_event: latest(eventId) });
  const pinged = (eventId: string) =>
    room({
      room_id: '!pinged:example.org',
      unread: 1,
      notifying: 1,
      latest_event: latest(eventId),
    });
  const before = backfillSignal([quiet('$a'), pinged('$b')]);

  expect(backfillSignal([quiet('$chatter'), pinged('$b')])).toBe(before);
  expect(backfillSignal([quiet('$a'), pinged('$ping')])).not.toBe(before);
});
