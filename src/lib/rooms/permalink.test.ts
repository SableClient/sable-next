import { expect, test } from 'vitest';

import type { RoomSummary } from '@/generated/RoomSummary';

import { permalinkPath, roomSectionPath } from './permalink';

function room(roomId: string, overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
    topic: null,
    avatar_url: null,
    is_direct: false,
    join_rule: 'public',
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

function child(roomId: string) {
  return { room_id: roomId, order: null, origin_server_ts: 0 };
}

test('a plain joined room lands under home', () => {
  const rooms = [room('!general:example.org')];
  expect(roomSectionPath(rooms, '!general:example.org')).toBe('/home/!general%3Aexample.org');
});

test('a direct room lands under direct, not home', () => {
  const rooms = [room('!dm:example.org', { is_direct: true })];
  expect(roomSectionPath(rooms, '!dm:example.org')).toBe('/direct/!dm%3Aexample.org');
});

test('a room reachable from a joined space lands under that space', () => {
  const rooms = [
    room('!space:example.org', { is_space: true, space_children: [child('!inner:example.org')] }),
    room('!inner:example.org'),
  ];
  expect(roomSectionPath(rooms, '!inner:example.org')).toBe(
    '/space/!space%3Aexample.org/!inner%3Aexample.org'
  );
});

test('a space the user has not joined does not claim its children', () => {
  const rooms = [
    room('!space:example.org', {
      is_space: true,
      state: 'invited',
      space_children: [child('!inner:example.org')],
    }),
    room('!inner:example.org'),
  ];
  expect(roomSectionPath(rooms, '!inner:example.org')).toBe('/home/!inner%3Aexample.org');
});

test('a space itself opens as a space', () => {
  const rooms = [room('!space:example.org', { is_space: true })];
  expect(roomSectionPath(rooms, '!space:example.org')).toBe('/space/!space%3Aexample.org');
});

test('the canonical alias wins over the room id, matching the sidebar links', () => {
  const rooms = [room('!general:example.org', { canonical_alias: '#general:example.org' })];
  expect(roomSectionPath(rooms, '!general:example.org')).toBe('/home/%23general%3Aexample.org');
});

test('an unknown room still resolves, so the timeline can report the failure', () => {
  expect(roomSectionPath([], '!missing:example.org')).toBe('/home/!missing%3Aexample.org');
});

test('a focused event rides along as a query param', () => {
  const rooms = [room('!general:example.org')];
  expect(roomSectionPath(rooms, '!general:example.org', '$abc')).toBe(
    '/home/!general%3Aexample.org?event=%24abc'
  );
});

test('a space drops a focused event, having no timeline to focus it in', () => {
  const rooms = [room('!space:example.org', { is_space: true })];
  expect(roomSectionPath(rooms, '!space:example.org', '$abc')).toBe('/space/!space%3Aexample.org');
});

test('a permalink fragment resolves through the same sectioning', () => {
  const rooms = [room('!dm:example.org', { is_direct: true })];
  expect(permalinkPath(rooms, encodeURIComponent('!dm:example.org'))).toBe(
    '/direct/!dm%3Aexample.org'
  );
});

test('a permalink fragment carries its event id', () => {
  const rooms = [room('!general:example.org')];
  const fragment = `${encodeURIComponent('!general:example.org')}/${encodeURIComponent('$abc')}`;
  expect(permalinkPath(rooms, fragment)).toBe('/home/!general%3Aexample.org?event=%24abc');
});

test('via servers ride along for a room the client has never seen', () => {
  expect(roomSectionPath([], '!missing:example.org', null, ['a.example', 'b.example'])).toBe(
    '/home/!missing%3Aexample.org?via=a.example&via=b.example'
  );
});

test('via is dropped for a room already in the list, having nothing left to help', () => {
  const rooms = [room('!general:example.org')];
  expect(roomSectionPath(rooms, '!general:example.org', null, ['a.example'])).toBe(
    '/home/!general%3Aexample.org'
  );
});

test('a focused event and via servers share one query', () => {
  expect(roomSectionPath([], '!missing:example.org', '$abc', ['a.example'])).toBe(
    '/home/!missing%3Aexample.org?event=%24abc&via=a.example'
  );
});

test('a permalink fragment carries its via servers, which sit inside the fragment', () => {
  const fragment = `${encodeURIComponent('!missing:example.org')}?via=a.example&via=b.example`;
  expect(permalinkPath([], fragment)).toBe(
    '/home/!missing%3Aexample.org?via=a.example&via=b.example'
  );
});

test('via inside the fragment does not leak into the room id', () => {
  const fragment = `${encodeURIComponent('!missing:example.org')}/${encodeURIComponent('$abc')}?via=a.example`;
  expect(permalinkPath([], fragment)).toBe(
    '/home/!missing%3Aexample.org?event=%24abc&via=a.example'
  );
});

test('a user permalink has no room to open', () => {
  expect(permalinkPath([], encodeURIComponent('@alice:example.org'))).toBeNull();
});

test('a fragment that names nothing resolvable is rejected', () => {
  expect(permalinkPath([], 'not-an-id')).toBeNull();
});
