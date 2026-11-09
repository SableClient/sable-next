import { afterEach, assert, expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

import { parseMatrixLink } from '#lib/rooms/matrix-link.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

import {
  copyRoomLink,
  existingChatPath,
  joinVia,
  matrixLinkPath,
  matrixToUrl,
  permalinkTarget,
  roomSectionPath,
  viaFor,
} from './permalink';

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return withCounts({
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
    topic: null,
    topic_html: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'public',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_tombstoned: false,
    room_kind: 'text',
    call_participants: [],
    screen_sharers: [],
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    space_children: [],
    bridge: null,
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  });
}

function child(roomId: string) {
  return { room_id: roomId, via: [], order: null, origin_server_ts: 0, suggested: false };
}

test('a plain joined room lands under rooms', () => {
  const rooms = [room('!general:example.org')];
  expect(roomSectionPath(rooms, '!general:example.org')).toBe('/rooms/!general%3Aexample.org');
});

test('a direct room lands under direct, not rooms', () => {
  const rooms = [room('!dm:example.org', { is_direct: true })];
  expect(roomSectionPath(rooms, '!dm:example.org')).toBe('/direct/!dm%3Aexample.org');
});

test('a room reachable from a joined space lands under that space', () => {
  const rooms = [
    room('!space:example.org', {
      room_kind: 'space',
      space_children: [child('!inner:example.org')],
    }),
    room('!inner:example.org'),
  ];
  expect(roomSectionPath(rooms, '!inner:example.org')).toBe(
    '/space/!space%3Aexample.org/!inner%3Aexample.org'
  );
});

test('a room in a subspace lands under the root space the sidebar shows', () => {
  const rooms = [
    room('!root:example.org', { room_kind: 'space', space_children: [child('!sub:example.org')] }),
    room('!sub:example.org', { room_kind: 'space', space_children: [child('!inner:example.org')] }),
    room('!inner:example.org'),
  ];
  expect(roomSectionPath(rooms, '!inner:example.org')).toBe(
    '/space/!root%3Aexample.org/!inner%3Aexample.org'
  );
});

test('a cycle between spaces still resolves to one of them', () => {
  const rooms = [
    room('!left:example.org', {
      room_kind: 'space',
      space_children: [child('!right:example.org')],
    }),
    room('!right:example.org', {
      room_kind: 'space',
      space_children: [child('!left:example.org'), child('!inner:example.org')],
    }),
    room('!inner:example.org'),
  ];
  expect(roomSectionPath(rooms, '!inner:example.org')).toBe(
    '/space/!right%3Aexample.org/!inner%3Aexample.org'
  );
});

test.each(['invited', 'tombstoned'])('a %s space does not claim its children', (status) => {
  const rooms = [
    room('!space:example.org', {
      room_kind: 'space',
      state: status === 'invited' ? 'invited' : 'joined',
      is_tombstoned: status === 'tombstoned',
      space_children: [child('!inner:example.org')],
    }),
    room('!inner:example.org'),
  ];
  expect(roomSectionPath(rooms, '!inner:example.org')).toBe('/rooms/!inner%3Aexample.org');
});

test('a space itself opens at its lobby', () => {
  const rooms = [room('!space:example.org', { room_kind: 'space' })];
  expect(roomSectionPath(rooms, '!space:example.org')).toBe('/space/!space%3Aexample.org/lobby');
});

test('an aliased room uses its canonical alias, matching the sidebar links', () => {
  const rooms = [room('!general:example.org', { canonical_alias: '#general:example.org' })];
  expect(roomSectionPath(rooms, '!general:example.org')).toBe('/rooms/%23general%3Aexample.org');
  expect(roomSectionPath(rooms, '#general:example.org')).toBe('/rooms/%23general%3Aexample.org');
});

test.each([true, false])(
  'spaces sharing an alias remain distinct with tombstone %s',
  (tombstoned) => {
    const rooms = [
      room('!old:example.org', {
        room_kind: 'space',
        canonical_alias: '#community:example.org',
        is_tombstoned: tombstoned,
      }),
      room('!current:example.org', {
        room_kind: 'space',
        canonical_alias: '#community:example.org',
      }),
    ];
    const aliasPath = '/space/%23community%3Aexample.org/lobby';
    const paths = tombstoned
      ? ['/space/!old%3Aexample.org/lobby', aliasPath]
      : [aliasPath, '/space/!current%3Aexample.org/lobby'];

    for (const [index, space] of rooms.entries()) {
      expect(permalinkTarget(rooms, encodeURIComponent(space.room_id))).toEqual({
        kind: 'room',
        path: paths[index],
      });
    }
    expect(roomSectionPath(rooms, '#community:example.org')).toBe(aliasPath);
  }
);

test('an unknown room still resolves, so the timeline can report the failure', () => {
  expect(roomSectionPath([], '!missing:example.org')).toBe('/rooms/!missing%3Aexample.org');
});

test('a focused event rides along as a query param', () => {
  const rooms = [room('!general:example.org')];
  expect(roomSectionPath(rooms, '!general:example.org', '$abc')).toBe(
    '/rooms/!general%3Aexample.org?event=%24abc'
  );
});

test('a space drops a focused event, having no timeline to focus it in', () => {
  const rooms = [room('!space:example.org', { room_kind: 'space' })];
  expect(roomSectionPath(rooms, '!space:example.org', '$abc')).toBe(
    '/space/!space%3Aexample.org/lobby'
  );
});

test('a permalink fragment resolves through the same sectioning', () => {
  const rooms = [room('!dm:example.org', { is_direct: true })];
  expect(permalinkTarget(rooms, encodeURIComponent('!dm:example.org'))).toEqual({
    kind: 'room',
    path: '/direct/!dm%3Aexample.org',
  });
});

test('a permalink fragment carries its event id', () => {
  const rooms = [room('!general:example.org')];
  const fragment = `${encodeURIComponent('!general:example.org')}/${encodeURIComponent('$abc')}`;
  expect(permalinkTarget(rooms, fragment)).toEqual({
    kind: 'room',
    path: '/rooms/!general%3Aexample.org?event=%24abc',
  });
});

test('via servers ride along for a room the client has never seen', () => {
  expect(roomSectionPath([], '!missing:example.org', null, ['a.example', 'b.example'])).toBe(
    '/rooms/!missing%3Aexample.org?via=a.example&via=b.example'
  );
});

test('via is dropped for a room already in the list, having nothing left to help', () => {
  const rooms = [room('!general:example.org')];
  expect(roomSectionPath(rooms, '!general:example.org', null, ['a.example'])).toBe(
    '/rooms/!general%3Aexample.org'
  );
});

test('a focused event and via servers share one query', () => {
  expect(roomSectionPath([], '!missing:example.org', '$abc', ['a.example'])).toBe(
    '/rooms/!missing%3Aexample.org?event=%24abc&via=a.example'
  );
});

test('a permalink fragment carries its via servers, which sit inside the fragment', () => {
  const fragment = `${encodeURIComponent('!missing:example.org')}?via=a.example&via=b.example`;
  expect(permalinkTarget([], fragment)).toEqual({
    kind: 'room',
    path: '/rooms/!missing%3Aexample.org?via=a.example&via=b.example',
  });
});

test('via inside the fragment does not leak into the room id', () => {
  const fragment = `${encodeURIComponent('!missing:example.org')}/${encodeURIComponent('$abc')}?via=a.example`;
  expect(permalinkTarget([], fragment)).toEqual({
    kind: 'room',
    path: '/rooms/!missing%3Aexample.org?event=%24abc&via=a.example',
  });
});

/* A room id is not routable on its own, so a link to one must advertise
   servers; a canonical alias carries its own and must not. */
test('a room id link advertises its via servers', () => {
  expect(matrixToUrl('!somewhere:example.org', ['elsewhere.ca'])).toBe(
    'https://matrix.to/#/!somewhere%3Aexample.org?via=elsewhere.ca'
  );
});

test('an alias link carries no via, being routable already', () => {
  expect(matrixToUrl('#lobby:example.org', ['elsewhere.ca'])).toBe(
    'https://matrix.to/#/%23lobby%3Aexample.org'
  );
});

test('an event link nests the event under the room', () => {
  expect(matrixToUrl('!somewhere:example.org', ['a.example', 'b.example'], '$event')).toBe(
    'https://matrix.to/#/!somewhere%3Aexample.org/%24event?via=a.example&via=b.example'
  );
});

test('a link the app generates parses back to what it named', () => {
  const url = matrixToUrl('!somewhere:example.org', ['elsewhere.ca'], '$event');
  expect(parseMatrixLink(url)).toEqual({
    kind: 'event',
    room_id: '!somewhere:example.org',
    event_id: '$event',
  });
});

test('a user permalink resolves to the user, having no route of its own', () => {
  expect(permalinkTarget([], encodeURIComponent('@alice:example.org'))).toEqual({
    kind: 'user',
    userId: '@alice:example.org',
  });
});

test('a fragment that names nothing resolvable is rejected', () => {
  expect(permalinkTarget([], 'not-an-id')).toBeNull();
});

test('only a room id is given routing help; an alias resolves itself', () => {
  expect(viaFor('!somewhere:example.org', ['a.example'])).toEqual(['a.example']);
  expect(viaFor('#lobby:example.org', ['a.example'])).toEqual([]);
});

function viaCore() {
  const viaServers = vi.fn().mockResolvedValue(['member.example']);
  const core = { rpc: { rooms: { viaServers } }, session: { user_id: '@me:home.example' } };
  return { core: core as unknown as Parameters<typeof joinVia>[0], viaServers };
}

test('a via naming another server is kept as is', async () => {
  const { core, viaServers } = viaCore();
  expect(await joinVia(core, ['home.example', 'other.example'], '!space:x')).toEqual([
    'home.example',
    'other.example',
  ]);
  expect(viaServers).not.toHaveBeenCalled();
});

test('a via naming only our server adds the parent space members', async () => {
  const { core, viaServers } = viaCore();
  expect(await joinVia(core, ['home.example'], '!space:x')).toEqual([
    'home.example',
    'member.example',
  ]);
  expect(viaServers).toHaveBeenCalledWith({ room_id: '!space:x' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function linkCore(via: string[] | Error) {
  const roomViaServers = vi.fn(() =>
    via instanceof Error ? Promise.reject(via) : Promise.resolve(via)
  );
  return { core: { rpc: { rooms: { viaServers: roomViaServers } } } as never, roomViaServers };
}

test('copying a room id link asks for via servers and carries the event', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { core, roomViaServers } = linkCore(['a.example']);

  await expect(
    copyRoomLink(core, { room_id: '!room:example.org', canonical_alias: null }, '$event')
  ).resolves.toBe(true);

  expect(roomViaServers).toHaveBeenCalledWith({ room_id: '!room:example.org' });
  expect(writeText).toHaveBeenCalledWith(matrixToUrl('!room:example.org', ['a.example'], '$event'));
});

test('copying an aliased room link skips the via lookup', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { core, roomViaServers } = linkCore(['a.example']);

  await copyRoomLink(core, { room_id: '!room:example.org', canonical_alias: '#lobby:example.org' });

  expect(roomViaServers).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenCalledWith('https://matrix.to/#/%23lobby%3Aexample.org');
});

test('a failed room link copy reports false instead of throwing', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
  const { core } = linkCore(new Error('offline'));

  await expect(
    copyRoomLink(core, { room_id: '!room:example.org', canonical_alias: null })
  ).resolves.toBe(false);
});

test.each([
  ['https://matrix.to/#/@alice:example.org', '/to/%40alice%3Aexample.org'],
  ['matrix:u/alice:example.org', '/to/%40alice%3Aexample.org'],
  ['https://matrix.to/#/%23lobby%3Aexample.org', '/to/%23lobby%3Aexample.org'],
  [
    'matrix:roomid/room:example.org/e/event?via=a.example&via=b.example',
    '/to/!room%3Aexample.org/%24event?via=a.example&via=b.example',
  ],
  [
    'https://matrix.to/#/!room:example.org/$event?via=a.example&via=b.example',
    '/to/!room%3Aexample.org/%24event?via=a.example&via=b.example',
  ],
])('routes incoming %s through the permalink page', (href, expected) => {
  expect(matrixLinkPath(href)).toBe(expected);
  const url = new URL(expected, 'https://sable.invalid');
  expect(permalinkTarget([], `${url.pathname.slice('/to/'.length)}${url.search}`)).not.toBeNull();
});

test.each([
  'https://example.org/#/!room:example.org',
  'https://matrix.to/#/',
  'moe.sable.next:/login?code=a',
])('ignores non-Matrix deep link %s', (href) => {
  expect(matrixLinkPath(href)).toBeNull();
});

test('incoming event links preserve the event and routing servers through /to', () => {
  const path = matrixLinkPath(
    'https://matrix.to/#/!room:example.org/$event?via=a.example&via=b.example'
  );
  assert(path !== null);
  const url = new URL(path, 'https://sable.invalid');
  expect(permalinkTarget([], `${url.pathname.slice('/to/'.length)}${url.search}`)).toEqual({
    kind: 'room',
    path: '/rooms/!room%3Aexample.org?event=%24event&via=a.example&via=b.example',
  });
});

test.each([
  [
    'matrix:u/alice:example.org?org.example.label=a+b',
    '/to/%40alice%3Aexample.org?org.example.label=a%2Bb',
  ],
  ['matrix:u/alice:example.org?action=chat', '/to/%40alice%3Aexample.org?action=chat'],
  ['matrix:u/alice:example.org?action=join', '/to/%40alice%3Aexample.org'],
  ['matrix:r/lobby:example.org?action=join', '/to/%23lobby%3Aexample.org?action=join'],
  ['matrix:roomid/opaque?action=chat', '/to/!opaque'],
  ['matrix:roomid/opaque/e/event?action=join', '/to/!opaque/%24event'],
  ['matrix:u/alice:example.org?action=unknown', '/to/%40alice%3Aexample.org'],
  ['matrix:roomid/opaque?via=a.example#reserved?via=wrong.example', '/to/!opaque?via=a.example'],
  [
    'matrix:u/alice:example.org?action=chat&org.example.label=a%26b&user=other&notified=event',
    '/to/%40alice%3Aexample.org?org.example.label=a%26b&action=chat',
  ],
])('preserves valid actions and extension parameters in %s', (href, expected) => {
  expect(matrixLinkPath(href)).toBe(expected);
});

test('chat links reuse joined DMs and ask before replacing left or tombstoned DMs', () => {
  const direct = room('!dm:example.org', {
    is_direct: true,
    direct_targets: ['@alice:example.org'],
  });
  expect(existingChatPath([direct], '@alice:example.org')).toBe('/direct/!dm%3Aexample.org');
  expect(existingChatPath([{ ...direct, state: 'left' }], '@alice:example.org')).toBeNull();
  expect(existingChatPath([{ ...direct, is_tombstoned: true }], '@alice:example.org')).toBeNull();
  expect(existingChatPath([direct], '@bob:example.org')).toBeNull();
  expect(
    existingChatPath(
      [{ ...direct, direct_targets: ['@alice:example.org', '@bob:example.org'] }],
      '@alice:example.org'
    )
  ).toBeNull();
});
