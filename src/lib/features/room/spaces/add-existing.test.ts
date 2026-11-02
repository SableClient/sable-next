import { expect, test } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { addableChildren } from './add-existing';

function room(
  roomId: string,
  name: string,
  extra: Partial<RoomListItemView> = {}
): RoomListItemView {
  return {
    room_id: roomId,
    name,
    canonical_alias: null,
    state: 'joined',
    is_direct: false,
    is_tombstoned: false,
    space_children: [],
    ...extra,
    display_name: name,
  } as unknown as RoomListItemView;
}

const space = room('!space:example.org', 'Space', {
  room_kind: 'space',
  space_children: [{ room_id: '!listed:example.org' }] as RoomListItemView['space_children'],
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
    room('!sub:example.org', 'Sub', { room_kind: 'space' }),
  ];
  expect(addableChildren(rooms, space, 'rooms', '').map((entry) => entry.name)).toEqual([
    'Alpha',
    'Zeta',
  ]);
  expect(addableChildren(rooms, space, 'spaces', '').map((entry) => entry.name)).toEqual(['Sub']);
});

test('filters by name and never offers a space that already contains this one', () => {
  const parent = room('!parent:example.org', 'Parent', {
    room_kind: 'space',
    space_children: [{ room_id: space.room_id }] as RoomListItemView['space_children'],
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
