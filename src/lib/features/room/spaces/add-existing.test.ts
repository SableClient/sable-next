import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

import { addableChildren } from './add-existing';

function room(roomId: string, name: string, extra: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: roomId,
    name,
    canonical_alias: null,
    state: 'joined',
    is_space: false,
    is_direct: false,
    is_tombstoned: false,
    space_children: [],
    ...extra,
  } as unknown as RoomSummary;
}

const space = room('!space:example.org', 'Space', {
  is_space: true,
  space_children: [{ room_id: '!listed:example.org' }] as RoomSummary['space_children'],
});

test('offers joined rooms that are not already children, sorted by name', () => {
  const rooms = [
    space,
    room('!zeta:example.org', 'Zeta'),
    room('!alpha:example.org', 'Alpha'),
    room('!listed:example.org', 'Listed'),
    room('!dm:example.org', 'Friend', { is_direct: true }),
    room('!invite:example.org', 'Invite', { state: 'invited' }),
    room('!old:example.org', 'Old', { is_tombstoned: true }),
    room('!sub:example.org', 'Sub', { is_space: true }),
  ];
  expect(addableChildren(rooms, space, 'rooms', '').map((entry) => entry.name)).toEqual([
    'Alpha',
    'Zeta',
  ]);
  expect(addableChildren(rooms, space, 'spaces', '').map((entry) => entry.name)).toEqual(['Sub']);
});

test('filters by name and never offers a space that already contains this one', () => {
  const parent = room('!parent:example.org', 'Parent', {
    is_space: true,
    space_children: [{ room_id: space.room_id }] as RoomSummary['space_children'],
  });
  const rooms = [
    space,
    parent,
    room('!alpha:example.org', 'Alpha'),
    room('!beta:example.org', 'Beta'),
  ];
  expect(addableChildren(rooms, space, 'rooms', ' alp ').map((entry) => entry.name)).toEqual([
    'Alpha',
  ]);
  expect(addableChildren(rooms, space, 'spaces', '')).toEqual([]);
});
