import type { RoomSummary } from '#src/generated/protocol';
import { expect, test } from 'vitest';

import catalog from './admin-commands.json';
import {
  adminScope,
  adminSuggestions,
  loadAdminCommands,
  type AdminCommand,
} from './admin-commands';

const commands: AdminCommand[] = [
  {
    name: 'rooms',
    description: 'Commands for managing rooms',
    children: [
      { name: 'list', description: 'List rooms' },
      {
        name: 'moderation',
        description: 'Moderation',
        children: [{ name: 'ban-room', description: 'Bans a room' }],
      },
    ],
  },
  {
    name: 'users',
    description: 'Commands for managing local users',
    restricted: true,
    children: [{ name: 'create', description: 'Create a new user', restricted: true }],
  },
  {
    name: 'server',
    description: 'Commands for managing the server',
    children: [
      { name: 'uptime', description: 'Time elapsed since startup' },
      { name: 'shutdown', description: 'Shutdown the server', restricted: true },
    ],
  },
];

function room(room_id: string, canonical_alias: string | null): RoomSummary {
  return { room_id, name: null, canonical_alias, avatar_url: null } as RoomSummary;
}

function labels(command: string, scope: Parameters<typeof adminSuggestions>[1]): string[] {
  return adminSuggestions(command, scope, commands).map((item) => item.label);
}

test('the admin room is the one aliased #admins on our own server', () => {
  const rooms = [
    room('!other:elsewhere.org', '#admins:elsewhere.org'),
    room('!a:example.org', '#admins:example.org'),
  ];

  expect(adminScope('!a:example.org', rooms, '@me:example.org')).toBe('adminRoom');
  expect(adminScope('!b:example.org', rooms, '@me:example.org')).toBe('escaped');
  expect(adminScope('!b:example.org', rooms.slice(0, 1), '@me:example.org')).toBeNull();
  expect(adminScope('!a:example.org', rooms, null)).toBeNull();
});

test('the prefix completes to the form the scope accepts', () => {
  expect(labels('!ad', 'adminRoom')).toEqual(['!admin']);
  expect(labels('\\!ad', 'escaped')).toEqual(['\\!admin']);
  expect(labels('!ad', 'escaped')).toEqual([]);
  expect(labels('!ad', null)).toEqual([]);
});

test('each word walks one level of the tree and the last one filters it', () => {
  expect(labels('!admin ', 'adminRoom')).toEqual(['rooms', 'users', 'server']);
  expect(labels('!admin rooms ', 'adminRoom')).toEqual(['list', 'moderation']);
  expect(labels('!admin rooms mod', 'adminRoom')).toEqual(['moderation']);
  expect(labels('!admin rooms moderation ', 'adminRoom')).toEqual(['ban-room']);
  expect(labels('!admin rooms list ', 'adminRoom')).toEqual([]);
  expect(labels('!admin nope ', 'adminRoom')).toEqual([]);
});

test('a suggestion inserts its own word and describes itself', () => {
  expect(adminSuggestions('!admin rooms l', 'adminRoom', commands)).toEqual([
    { id: '!admin rooms list', insert: 'list', label: 'list', detail: 'List rooms' },
  ]);
});

test('outside the admin room restricted commands are not offered', () => {
  expect(labels('\\!admin ', 'escaped')).toEqual(['rooms', 'server']);
  expect(labels('\\!admin server ', 'escaped')).toEqual(['uptime']);
  expect(labels('\\!admin users ', 'escaped')).toEqual([]);
  expect(labels('!admin ', 'escaped')).toEqual([]);
  expect(labels('\\!admin ', 'adminRoom')).toEqual([]);
});

test('the shipped catalog describes every command', () => {
  const walk = (level: readonly AdminCommand[]): AdminCommand[] =>
    level.flatMap((command) => [command, ...walk(command.children ?? [])]);
  const all = walk(catalog.commands);

  expect(all.length).toBeGreaterThan(100);
  expect(all.filter((command) => command.description === '')).toEqual([]);
});

test('until the catalog loads only the prefix completes', async () => {
  expect(adminSuggestions('!ad', 'adminRoom', null).map((item) => item.label)).toEqual(['!admin']);
  expect(adminSuggestions('!admin ', 'adminRoom', null)).toEqual([]);
  expect(await loadAdminCommands()).toBe(catalog.commands);
});
