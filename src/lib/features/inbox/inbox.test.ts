import { expect, test } from 'vitest';

import type { BookmarkView } from '#src/generated/BookmarkView';
import type { RoomSummary } from '#src/generated/RoomSummary';

import {
  countInvites,
  countNotifications,
  filteredBookmarks,
  hasMarkedUnread,
  inviter,
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
    has_space_parent: false,
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    unread: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  };
}

test('an unknown filter falls back to showing everything', () => {
  expect(parseFilter(null)).toBe('all');
  expect(parseFilter('unread')).toBe('all');
  expect(parseFilter('mentions')).toBe('mentions');
});

test('a room notifies on mentions only, a chat on any message', () => {
  const rooms = [
    room({ room_id: '!chat', is_direct: true, unread: 3 }),
    room({ room_id: '!quiet-room', unread: 7 }),
    room({ room_id: '!loud-room', unread: 7, highlight: 2 }),
  ];

  expect(notifications(rooms, 'all').map((each) => each.room_id)).toEqual(['!chat', '!loud-room']);
  expect(countNotifications(rooms)).toBe(5);
});

test('filters narrow to mentions or to chats', () => {
  const rooms = [
    room({ room_id: '!chat', is_direct: true, unread: 1 }),
    room({ room_id: '!mention', highlight: 1 }),
  ];

  expect(notifications(rooms, 'direct').map((each) => each.room_id)).toEqual(['!chat']);
  expect(notifications(rooms, 'mentions').map((each) => each.room_id)).toEqual(['!mention']);
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

test('pending invitations are listed newest first, joined rooms excluded', () => {
  const invited = (id: string, timestamp: number): RoomSummary =>
    room({
      room_id: id,
      state: 'invited',
      latest_event: {
        sender: '@ada:example.org',
        body: 'invited you',
        timestamp,
        sending: false,
        event_id: null,
      },
    });
  const rooms = [invited('!old', 10), room({ room_id: '!joined' }), invited('!new', 20)];

  expect(pendingInvites(rooms).map((each) => each.room_id)).toEqual(['!new', '!old']);
  expect(countInvites(rooms)).toBe(2);
});

test('the inviter comes from the invitation event', () => {
  const invite = room({
    state: 'invited',
    latest_event: {
      sender: '@ada:example.org',
      body: 'invited you',
      timestamp: 1,
      sending: false,
      event_id: null,
    },
  });

  expect(inviter(invite)).toBe('@ada:example.org');
  expect(inviter(room({ state: 'invited' }))).toBeNull();
  expect(senderName('@ada:example.org')).toBe('ada');
  expect(senderName('ada')).toBe('ada');
});

function bookmark(overrides: Partial<BookmarkView>): BookmarkView {
  return {
    bookmark_id: 'bmk_one',
    room_id: '!room:example.org',
    event_id: '$one',
    room_name: null,
    sender: null,
    body_preview: null,
    event_ts: 0,
    bookmarked_ts: 0,
    ...overrides,
  };
}

test('bookmarks are ordered newest-saved first', () => {
  const bookmarks = [
    bookmark({ bookmark_id: 'bmk_old', bookmarked_ts: 10 }),
    bookmark({ bookmark_id: 'bmk_new', bookmarked_ts: 20 }),
  ];

  expect(filteredBookmarks(bookmarks, '').map((each) => each.bookmark_id)).toEqual([
    'bmk_new',
    'bmk_old',
  ]);
});

test('a bookmark search matches the room, the sender or the preview', () => {
  const bookmarks = [
    bookmark({ bookmark_id: 'bmk_room', room_name: 'Kittens' }),
    bookmark({ bookmark_id: 'bmk_sender', sender: '@ada:example.org' }),
    bookmark({ bookmark_id: 'bmk_preview', body_preview: 'deploy the release' }),
    bookmark({ bookmark_id: 'bmk_none' }),
  ];

  expect(filteredBookmarks(bookmarks, 'kitt').map((each) => each.bookmark_id)).toEqual([
    'bmk_room',
  ]);
  expect(filteredBookmarks(bookmarks, 'ada').map((each) => each.bookmark_id)).toEqual([
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
