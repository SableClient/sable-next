import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';
import type { SpaceChildEdge } from '#src/generated/SpaceChildEdge';

import { wouldCreateCycle } from './add-to-space';

function edge(roomId: string): SpaceChildEdge {
  return { room_id: roomId, order: null, origin_server_ts: 0, suggested: false };
}

function room(roomId: string, overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
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
    supports_knock: false,
    supports_restricted: false,
    supports_knock_restricted: false,
    space_children: [],
    unread: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  };
}

test('a space cannot become its own child', () => {
  const rooms = [room('!a', { is_space: true })];
  expect(wouldCreateCycle(rooms, '!a', '!a')).toBe(true);
});

test('a space cannot be added under one of its own descendants', () => {
  const rooms = [
    room('!a', { is_space: true, space_children: [edge('!b')] }),
    room('!b', { is_space: true, space_children: [edge('!c')] }),
    room('!c', { is_space: true }),
  ];

  expect(wouldCreateCycle(rooms, '!c', '!a')).toBe(true);
});

test('adding an unrelated space is not a cycle', () => {
  const rooms = [room('!a', { is_space: true }), room('!b', { is_space: true })];

  expect(wouldCreateCycle(rooms, '!a', '!b')).toBe(false);
});

test('a plain room is never a cycle', () => {
  const rooms = [room('!a', { is_space: true }), room('!room')];
  expect(wouldCreateCycle(rooms, '!a', '!room')).toBe(false);
});
