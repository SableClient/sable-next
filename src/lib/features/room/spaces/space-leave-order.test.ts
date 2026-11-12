import { expect, test } from 'vitest';

import type { RoomListItemView, SpaceChildEdge } from '#src/generated/protocol';

import { joinedSpaceChildrenLeaveOrder, recursiveSpaceLeaveOrder } from './space-leave-order';
import { roomView } from '#lib/test-support/room-views.js';

function edge(roomId: string): SpaceChildEdge {
  return { room_id: roomId, via: [], order: null, origin_server_ts: 0, suggested: false };
}

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return roomView({ room_id: roomId, name: roomId, ...overrides });
}

test('leaves rooms before their space, deepest first', () => {
  const rooms = [
    room('!root', { room_kind: 'space', space_children: [edge('!a'), edge('!sub')] }),
    room('!a'),
    room('!sub', { room_kind: 'space', space_children: [edge('!b')] }),
    room('!b'),
  ];

  const { order, roomCount, subspaceCount } = joinedSpaceChildrenLeaveOrder(rooms, '!root');

  expect(order).toEqual(['!a', '!b', '!sub']);
  expect(roomCount).toBe(2);
  expect(subspaceCount).toBe(1);
});

test('recursive order leaves the root space last', () => {
  const rooms = [room('!root', { room_kind: 'space', space_children: [edge('!a')] }), room('!a')];

  expect(recursiveSpaceLeaveOrder(rooms, '!root')).toEqual(['!a', '!root']);
});

test('skips rooms that are not joined', () => {
  const rooms = [
    room('!root', { room_kind: 'space', space_children: [edge('!a'), edge('!left')] }),
    room('!a'),
    room('!left', { state: 'invited' }),
  ];

  const { order, roomCount } = joinedSpaceChildrenLeaveOrder(rooms, '!root');

  expect(order).toEqual(['!a']);
  expect(roomCount).toBe(1);
});

test('skips a tombstoned child', () => {
  const rooms = [
    room('!root', { room_kind: 'space', space_children: [edge('!old')] }),
    room('!old', { is_tombstoned: true }),
  ];

  expect(joinedSpaceChildrenLeaveOrder(rooms, '!root').order).toEqual([]);
});

test('does not loop on a cyclical space graph', () => {
  const rooms = [
    room('!root', { room_kind: 'space', space_children: [edge('!sub')] }),
    room('!sub', { room_kind: 'space', space_children: [edge('!root')] }),
  ];

  expect(joinedSpaceChildrenLeaveOrder(rooms, '!root').order).toEqual(['!sub']);
});

test('an unjoined root leaves nothing', () => {
  const rooms = [room('!root', { room_kind: 'space', state: 'invited' })];

  expect(joinedSpaceChildrenLeaveOrder(rooms, '!root').order).toEqual([]);
});
