import { expect, test } from 'vitest';

import type { RoomSummary } from '@/generated/RoomSummary';

import { unreadSpaceIds } from './spaces';

function room(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    room_id: '!room:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    avatar_url: null,
    is_direct: false,
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: false,
    space_children: [],
    unread: 0,
    highlight: 0,
    latest_event: null,
    ...overrides,
  };
}

test('does not mark a space unread for a muted child room', () => {
  const space = room({
    room_id: '!space:example.org',
    is_space: true,
    space_children: [{ room_id: '!muted:example.org', order: null, origin_server_ts: 1 }],
  });
  const muted = room({ room_id: '!muted:example.org', unread: 3 });

  expect(unreadSpaceIds([space], [space, muted], new Set([muted.room_id]))).toEqual(new Set());
});
