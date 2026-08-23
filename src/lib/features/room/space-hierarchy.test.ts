import { expect, test } from 'vitest';

import type { SpaceChildEdge } from '#src/generated/SpaceChildEdge';
import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';

import { buildHierarchySections, lobbyAction } from './space-hierarchy';

function edge(roomId: string, overrides: Partial<SpaceChildEdge> = {}): SpaceChildEdge {
  return { room_id: roomId, order: null, origin_server_ts: 0, suggested: false, ...overrides };
}

function room(
  roomId: string,
  overrides: Partial<SpaceHierarchyRoomView> = {}
): SpaceHierarchyRoomView {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
    topic: null,
    avatar_url: null,
    is_space: false,
    is_voice: false,
    num_joined_members: 1,
    join_rule: 'public',
    guest_can_join: false,
    children: [],
    ...overrides,
  };
}

test.each([
  ['public', false, 'join'],
  ['restricted', false, 'join'],
  ['knock_restricted', false, 'join'],
  ['knock', false, 'knock'],
  ['invite', true, 'join'],
  ['invite', false, null],
  ['private', false, null],
  ['unknown', false, null],
] as const)('selects the supported lobby action for %s rooms', (joinRule, invited, action) => {
  expect(lobbyAction(joinRule, invited)).toBe(action);
});

test('rooms follow the order of the parent edges, not the response order', () => {
  const rooms = [
    room('!space', { is_space: true, children: [edge('!b'), edge('!a')] }),
    room('!a'),
    room('!b'),
  ];

  const sections = buildHierarchySections(rooms, '!space');
  expect(sections).toHaveLength(1);
  expect(sections[0].space).toBeNull();
  expect(sections[0].rooms.map((entry) => entry.room.room_id)).toEqual(['!b', '!a']);
});

test('each subspace becomes its own section after the root section', () => {
  const rooms = [
    room('!space', { is_space: true, children: [edge('!direct'), edge('!sub')] }),
    room('!direct'),
    room('!sub', { is_space: true, children: [edge('!nested')] }),
    room('!nested'),
  ];

  const sections = buildHierarchySections(rooms, '!space');
  expect(
    sections.map((section) => [
      section.space?.room_id ?? null,
      section.depth,
      section.rooms.map((entry) => entry.room.room_id),
    ])
  ).toEqual([
    [null, 0, ['!direct']],
    ['!sub', 1, ['!nested']],
  ]);
});

test('a subspace holding no rooms never becomes a lone heading', () => {
  const rooms = [
    room('!space', { is_space: true, children: [edge('!a'), edge('!empty')] }),
    room('!a'),
    room('!empty', { is_space: true }),
  ];

  const sections = buildHierarchySections(rooms, '!space');
  expect(sections.map((section) => section.space?.room_id ?? null)).toEqual([null]);
});

test('suggested comes from the edge, so it can differ per parent', () => {
  const rooms = [
    room('!space', { is_space: true, children: [edge('!a', { suggested: true }), edge('!sub')] }),
    room('!a'),
    room('!sub', { is_space: true, children: [edge('!a')] }),
  ];

  const sections = buildHierarchySections(rooms, '!space');
  expect(sections.flatMap((section) => section.rooms.map((entry) => entry.suggested))).toEqual([
    true,
    false,
  ]);
});

test('a room under two parents gets distinct keys', () => {
  const rooms = [
    room('!space', { is_space: true, children: [edge('!a'), edge('!sub')] }),
    room('!a'),
    room('!sub', { is_space: true, children: [edge('!a')] }),
  ];

  const keys = buildHierarchySections(rooms, '!space').flatMap((section) =>
    section.rooms.map((entry) => entry.key)
  );
  expect(new Set(keys).size).toBe(keys.length);
});

test('a cycle terminates instead of recursing forever', () => {
  const rooms = [
    room('!space', { is_space: true, children: [edge('!a'), edge('!sub')] }),
    room('!a'),
    room('!sub', { is_space: true, children: [edge('!b'), edge('!space')] }),
    room('!b'),
  ];

  const sections = buildHierarchySections(rooms, '!space');
  expect(sections.map((section) => section.space?.room_id ?? null)).toEqual([null, '!sub']);
});

test('children the response never described are skipped', () => {
  const rooms = [
    room('!space', { is_space: true, children: [edge('!missing'), edge('!a')] }),
    room('!a'),
  ];

  const sections = buildHierarchySections(rooms, '!space');
  expect(sections[0].rooms.map((entry) => entry.room.room_id)).toEqual(['!a']);
});
