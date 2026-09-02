import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';

import { spaceUnreadCounts } from './spaces';

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

test('does not mark a space unread for a muted child room', () => {
  const space = room({
    room_id: '!space:example.org',
    is_space: true,
    space_children: [
      { room_id: '!muted:example.org', order: null, origin_server_ts: 1, suggested: false },
    ],
  });
  const muted = room({ room_id: '!muted:example.org', unread: 3 });

  expect(spaceUnreadCounts([space], [space, muted], new Set([muted.room_id]))).toEqual(new Map());
});

test('sums the mentions of a space across its nested rooms, counting each room once', () => {
  const root = room({
    room_id: '!root:example.org',
    is_space: true,
    space_children: [
      { room_id: '!sub:example.org', order: null, origin_server_ts: 1, suggested: false },
      { room_id: '!shared:example.org', order: null, origin_server_ts: 1, suggested: false },
    ],
  });
  const sub = room({
    room_id: '!sub:example.org',
    is_space: true,
    space_children: [
      { room_id: '!deep:example.org', order: null, origin_server_ts: 1, suggested: false },
      { room_id: '!shared:example.org', order: null, origin_server_ts: 1, suggested: false },
    ],
  });
  const deep = room({ room_id: '!deep:example.org', unread: 4, highlight: 1 });
  const shared = room({ room_id: '!shared:example.org', unread: 2, highlight: 2 });

  expect(spaceUnreadCounts([root, sub], [root, sub, deep, shared])).toEqual(
    new Map([
      ['!root:example.org', { unread: 6, highlight: 3, marked: false }],
      ['!sub:example.org', { unread: 6, highlight: 3, marked: false }],
    ])
  );
});

test('a hand-marked room dots its parent space, even muted', () => {
  const root = room({
    room_id: '!root:example.org',
    is_space: true,
    space_children: [
      { room_id: '!muted:example.org', order: null, origin_server_ts: 1, suggested: false },
    ],
  });
  const muted = room({ room_id: '!muted:example.org', marked_unread: true });

  expect(spaceUnreadCounts([root], [root, muted], new Set(['!muted:example.org']))).toEqual(
    new Map([['!root:example.org', { unread: 0, highlight: 0, marked: true }]])
  );
});
