import { expect, test } from 'vitest';

import type { RoomListItemView, SpaceChildEdge } from '#src/generated/protocol';

import { wouldCreateCycle } from './add-to-space';
import { roomView } from '#lib/test-support/room-views.js';

function edge(roomId: string): SpaceChildEdge {
  return { room_id: roomId, via: [], order: null, origin_server_ts: 0, suggested: false };
}

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return roomView({ room_id: roomId, name: roomId, ...overrides });
}

test('a space cannot become its own child', () => {
  const rooms = [room('!a', { room_kind: 'space' })];
  expect(wouldCreateCycle(rooms, '!a', '!a')).toBe(true);
});

test('a space cannot be added under one of its own descendants', () => {
  const rooms = [
    room('!a', { room_kind: 'space', space_children: [edge('!b')] }),
    room('!b', { room_kind: 'space', space_children: [edge('!c')] }),
    room('!c', { room_kind: 'space' }),
  ];

  expect(wouldCreateCycle(rooms, '!c', '!a')).toBe(true);
});

test('adding an unrelated space is not a cycle', () => {
  const rooms = [room('!a', { room_kind: 'space' }), room('!b', { room_kind: 'space' })];

  expect(wouldCreateCycle(rooms, '!a', '!b')).toBe(false);
});

test('a plain room is never a cycle', () => {
  const rooms = [room('!a', { room_kind: 'space' }), room('!room')];
  expect(wouldCreateCycle(rooms, '!a', '!room')).toBe(false);
});
