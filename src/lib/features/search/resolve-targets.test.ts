import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/RoomSummary';

import type { SpaceChildEdge } from '#src/generated/SpaceChildEdge';

import {
  resolveRoomTarget,
  resolveSpaceRooms,
  resolveSpaceTarget,
  resolveUserTarget,
} from './resolve-targets';

function room(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    room_id: '!id:example.org',
    canonical_alias: null,
    name: null,
    topic: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: false,
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

const rooms = [
  room({
    room_id: '!design:example.org',
    canonical_alias: '#design-crew:example.org',
    name: 'Design crew',
  }),
  room({
    room_id: '!general:example.org',
    canonical_alias: '#general:example.org',
    name: 'General',
  }),
  room({ room_id: '!nameless:example.org' }),
];

test('a full alias resolves', () => {
  expect(resolveRoomTarget(rooms, '#general:example.org')).toBe('!general:example.org');
});

test('an alias localpart resolves with or without the hash', () => {
  expect(resolveRoomTarget(rooms, 'general')).toBe('!general:example.org');
  expect(resolveRoomTarget(rooms, '#general')).toBe('!general:example.org');
});

test('a room id resolves', () => {
  expect(resolveRoomTarget(rooms, '!nameless:example.org')).toBe('!nameless:example.org');
});

test('a display name with a space resolves', () => {
  expect(resolveRoomTarget(rooms, 'Design crew')).toBe('!design:example.org');
  expect(resolveRoomTarget(rooms, 'design crew')).toBe('!design:example.org');
});

test('an alias localpart wins over a partial name match', () => {
  expect(resolveRoomTarget(rooms, 'design-crew')).toBe('!design:example.org');
});

test('an unknown room resolves to nothing rather than the first room', () => {
  expect(resolveRoomTarget(rooms, 'nowhere')).toBeUndefined();
  expect(resolveRoomTarget(rooms, '')).toBeUndefined();
});

const senders = [
  { userId: '@ada:example.org', displayName: 'Ada Lovelace' },
  { userId: '@erwan:other.example', displayName: 'Erwan' },
];

test('a full user id is taken as given even when unseen', () => {
  expect(resolveUserTarget([], '@stranger:example.org')).toBe('@stranger:example.org');
});

test('a localpart resolves against known senders', () => {
  expect(resolveUserTarget(senders, 'ada')).toBe('@ada:example.org');
  expect(resolveUserTarget(senders, '@ada')).toBe('@ada:example.org');
  expect(resolveUserTarget(senders, 'ADA')).toBe('@ada:example.org');
});

test('an unknown localpart resolves to nothing', () => {
  expect(resolveUserTarget(senders, 'nobody')).toBeUndefined();
  expect(resolveUserTarget(senders, '')).toBeUndefined();
});

test('a bare localpart is not mistaken for an id', () => {
  expect(resolveUserTarget([], 'ada')).toBeUndefined();
});

test('a display name resolves, including one with a space', () => {
  expect(resolveUserTarget(senders, 'Ada Lovelace')).toBe('@ada:example.org');
  expect(resolveUserTarget(senders, 'ada lovelace')).toBe('@ada:example.org');
});

function edge(roomId: string): SpaceChildEdge {
  return { room_id: roomId, order: null, origin_server_ts: 0, suggested: false };
}

const spaceRooms = [
  room({
    room_id: '!eng:example.org',
    canonical_alias: '#eng:example.org',
    name: 'Engineering',
    is_space: true,
    space_children: [edge('!dev:example.org'), edge('!subteam:example.org')],
  }),
  room({
    room_id: '!subteam:example.org',
    name: 'Subteam',
    is_space: true,
    space_children: [edge('!ops:example.org')],
  }),
  room({ room_id: '!dev:example.org', canonical_alias: '#dev:example.org', name: 'Dev' }),
  room({ room_id: '!ops:example.org', canonical_alias: '#ops:example.org', name: 'Ops' }),
  room({ room_id: '!unrelated:example.org', name: 'Unrelated' }),
];

test('a space alias or name resolves to the space room id', () => {
  expect(resolveSpaceTarget(spaceRooms, 'eng')).toBe('!eng:example.org');
  expect(resolveSpaceTarget(spaceRooms, 'Engineering')).toBe('!eng:example.org');
});

test('a non-space room is not resolved as a space', () => {
  expect(resolveSpaceTarget(spaceRooms, 'Dev')).toBeUndefined();
});

test('a space resolves to every non-space room in its subtree', () => {
  expect(resolveSpaceRooms(spaceRooms, 'eng')).toEqual(['!dev:example.org', '!ops:example.org']);
});

test('an unknown space resolves to nothing', () => {
  expect(resolveSpaceRooms(spaceRooms, 'nowhere')).toBeUndefined();
});
