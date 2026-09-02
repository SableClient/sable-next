import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';
import type { SpaceChildEdge } from '#src/generated/SpaceChildEdge';
import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';

import {
  applyChildOverrides,
  buildHierarchySections,
  childEdges,
  edgeSignature,
  levelTargets,
  lobbyAction,
  lobbyPhase,
  localHierarchyRooms,
  mergeHierarchyRooms,
  placeholderRows,
} from './space-hierarchy';

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

test('a first page of nothing but subspaces yields no sections yet', () => {
  const rooms = [
    room('!root', { is_space: true, children: [edge('!sub')] }),
    room('!sub', { is_space: true, children: [edge('!chat')] }),
  ];

  expect(buildHierarchySections(rooms, '!root')).toEqual([]);
});

test('a level still in flight is not an empty space', () => {
  expect(lobbyPhase(0, true)).toBe('loading');
  expect(lobbyPhase(0, false)).toBe('empty');
  expect(lobbyPhase(3, true)).toBe('ready');
  expect(lobbyPhase(3, false)).toBe('ready');
});

test('a child on a later page does not drop its whole section', () => {
  const firstPage = [
    room('!root', { is_space: true, children: [edge('!early'), edge('!late')] }),
    room('!early'),
  ];
  const [section] = buildHierarchySections(firstPage, '!root');
  expect(section.rooms.map((entry) => entry.room.room_id)).toEqual(['!early']);

  const bothPages = [...firstPage, room('!late')];
  const [complete] = buildHierarchySections(bothPages, '!root');
  expect(complete.rooms.map((entry) => entry.room.room_id)).toEqual(['!early', '!late']);
});

function summary(roomId: string, overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
    topic: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'public',
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

test('the local tree is walked from this account own state', () => {
  const local = localHierarchyRooms(
    [
      summary('!space', { is_space: true, space_children: [edge('!a'), edge('!sub')] }),
      summary('!a'),
      summary('!sub', { is_space: true, space_children: [edge('!nested')] }),
      summary('!nested'),
      summary('!elsewhere'),
    ],
    '!space'
  );

  expect(local.map((room) => room.room_id)).toEqual(['!space', '!a', '!sub', '!nested']);
  expect(local.every((room) => room.num_joined_members === null)).toBe(true);
});

test('a space this account has left contributes no children', () => {
  const local = localHierarchyRooms(
    [
      summary('!space', { is_space: true, state: 'left', space_children: [edge('!a')] }),
      summary('!a'),
    ],
    '!space'
  );

  expect(local.map((room) => room.room_id)).toEqual(['!space']);
});

test('a local cycle terminates', () => {
  const local = localHierarchyRooms(
    [
      summary('!space', { is_space: true, space_children: [edge('!sub')] }),
      summary('!sub', { is_space: true, space_children: [edge('!space')] }),
    ],
    '!space'
  );

  expect(local.map((room) => room.room_id)).toEqual(['!space', '!sub']);
});

test('the chunk fills in what local state cannot know', () => {
  const local = localHierarchyRooms([summary('!a', { name: 'Local name' })], '!a');
  const [merged] = mergeHierarchyRooms(local, [
    room('!a', { name: 'Server name', num_joined_members: 42, topic: 'From the server' }),
  ]);

  expect(merged.name).toBe('Local name');
  expect(merged.num_joined_members).toBe(42);
  expect(merged.topic).toBe('From the server');
});

test('a room only the server describes survives the merge', () => {
  const merged = mergeHierarchyRooms([], [room('!a', { num_joined_members: 3 })]);
  expect(merged.map((entry) => entry.num_joined_members)).toEqual([3]);
});

test('an undescribed subspace keeps its heading and counts what it waits for', () => {
  const rooms = [
    room('!root', { is_space: true, children: [edge('!sub')] }),
    room('!sub', { is_space: true, children: [edge('!chat'), edge('!other')] }),
  ];

  const [section] = buildHierarchySections(rooms, '!root', { loaded: new Set(['!root']) });
  expect(section.space?.room_id).toBe('!sub');
  expect(section.loaded).toBe(false);
  expect(section.pending).toBe(2);
  expect(placeholderRows(section)).toBe(2);
});

test('a described subspace holding nothing is dropped again', () => {
  const rooms = [
    room('!root', { is_space: true, children: [edge('!sub')] }),
    room('!sub', { is_space: true }),
  ];

  expect(buildHierarchySections(rooms, '!root', { loaded: new Set(['!root', '!sub']) })).toEqual(
    []
  );
});

test('a section with no known edges still reserves rows to fill', () => {
  const rooms = [
    room('!root', { is_space: true, children: [edge('!sub')] }),
    room('!sub', { is_space: true }),
  ];

  const [section] = buildHierarchySections(rooms, '!root', { loaded: new Set(['!root']) });
  expect(placeholderRows(section)).toBe(3);
});

test('a section already showing rooms reserves none once it has them all', () => {
  const rooms = [room('!root', { is_space: true, children: [edge('!a')] }), room('!a')];

  const [section] = buildHierarchySections(rooms, '!root', { loaded: new Set(['!root']) });
  expect(section.pending).toBe(0);
  expect(placeholderRows(section)).toBe(0);
});

test('every open section is a level to fetch, the closed ones are not', () => {
  const rooms = [
    room('!root', { is_space: true, children: [edge('!a'), edge('!open'), edge('!shut')] }),
    room('!a'),
    room('!open', { is_space: true, children: [edge('!b')] }),
    room('!b'),
    room('!shut', { is_space: true, children: [edge('!c')] }),
    room('!c'),
  ];
  const sections = buildHierarchySections(rooms, '!root');
  const shut = sections.find((section) => section.space?.room_id === '!shut');

  expect(levelTargets(sections, '!root')).toEqual(['!root', '!open', '!shut']);
  expect(levelTargets(sections, '!root', new Set([shut?.key ?? '']))).toEqual(['!root', '!open']);
});

test('an override replaces a parent edges until its baseline moves', () => {
  const rooms = [
    room('!root', { is_space: true, children: [edge('!a'), edge('!b')] }),
    room('!a'),
    room('!b'),
  ];
  const baseline = edgeSignature(childEdges(rooms, '!root'));

  const overridden = applyChildOverrides(rooms, [
    { parentId: '!root', children: [edge('!b'), edge('!a')], baseline },
  ]);

  expect(childEdges(overridden, '!root').map((child) => child.room_id)).toEqual(['!b', '!a']);
  expect(childEdges(rooms, '!root').map((child) => child.room_id)).toEqual(['!a', '!b']);
  expect(edgeSignature(childEdges(overridden, '!root'))).not.toBe(baseline);
});

test('a subspace the server refuses stays as a heading', () => {
  const rooms = [
    room('!root', { is_space: true, children: [edge('!sub')] }),
    room('!sub', { is_space: true }),
  ];

  const [section] = buildHierarchySections(rooms, '!root', {
    loaded: new Set(['!root', '!sub']),
    failed: new Set(['!sub']),
  });

  expect(section.space?.room_id).toBe('!sub');
  expect(section.failed).toBe(true);
  expect(placeholderRows(section)).toBe(0);
});
