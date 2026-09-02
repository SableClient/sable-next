import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';
import type { SpaceChildEdge } from '#src/generated/SpaceChildEdge';

import { joinedSpaceChildrenLeaveOrder, recursiveSpaceLeaveOrder } from './space-leave-order';

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

test('leaves rooms before their space, deepest first', () => {
  const rooms = [
    room('!root', { is_space: true, space_children: [edge('!a'), edge('!sub')] }),
    room('!a'),
    room('!sub', { is_space: true, space_children: [edge('!b')] }),
    room('!b'),
  ];

  const { order, roomCount, subspaceCount } = joinedSpaceChildrenLeaveOrder(rooms, '!root');

  expect(order).toEqual(['!a', '!b', '!sub']);
  expect(roomCount).toBe(2);
  expect(subspaceCount).toBe(1);
});

test('recursive order leaves the root space last', () => {
  const rooms = [room('!root', { is_space: true, space_children: [edge('!a')] }), room('!a')];

  expect(recursiveSpaceLeaveOrder(rooms, '!root')).toEqual(['!a', '!root']);
});

test('skips rooms that are not joined', () => {
  const rooms = [
    room('!root', { is_space: true, space_children: [edge('!a'), edge('!left')] }),
    room('!a'),
    room('!left', { state: 'invited' }),
  ];

  const { order, roomCount } = joinedSpaceChildrenLeaveOrder(rooms, '!root');

  expect(order).toEqual(['!a']);
  expect(roomCount).toBe(1);
});

test('skips a tombstoned child', () => {
  const rooms = [
    room('!root', { is_space: true, space_children: [edge('!old')] }),
    room('!old', { is_tombstoned: true }),
  ];

  expect(joinedSpaceChildrenLeaveOrder(rooms, '!root').order).toEqual([]);
});

test('does not loop on a cyclical space graph', () => {
  const rooms = [
    room('!root', { is_space: true, space_children: [edge('!sub')] }),
    room('!sub', { is_space: true, space_children: [edge('!root')] }),
  ];

  expect(joinedSpaceChildrenLeaveOrder(rooms, '!root').order).toEqual(['!sub']);
});

test('an unjoined root leaves nothing', () => {
  const rooms = [room('!root', { is_space: true, state: 'invited' })];

  expect(joinedSpaceChildrenLeaveOrder(rooms, '!root').order).toEqual([]);
});
