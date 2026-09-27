import type { RoomSummary } from '#src/generated/protocol';
import { expect, test } from 'vitest';

import catalog from './admin-commands.json';
import {
  adminBot,
  adminBotCommands,
  adminCommandTree,
  adminScope,
  adminSuggestions,
  loadAdminCommands,
  type AdminCommand,
} from './admin-commands';
import { buildInvocation, draftsFromText, parseBotCommands } from './bot-commands';

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

test('every command in the shipped catalog becomes a bot command', () => {
  const leaves = (level: readonly AdminCommand[]): AdminCommand[] =>
    level.flatMap((command) => (command.children ? leaves(command.children) : [command]));
  const bot = '@conduit:example.org';

  expect(adminBotCommands(catalog.commands, bot, 'adminRoom')).toHaveLength(
    leaves(catalog.commands).length
  );
  expect(adminBotCommands(catalog.commands, bot, 'escaped')).toHaveLength(
    leaves(catalog.commands).filter((command) => !command.restricted).length
  );
});

test('a catalog command is written back as the text continuwuity parses', () => {
  const reset = adminBotCommands(catalog.commands, '@conduit:example.org', 'adminRoom').find(
    (command) => command.command === 'users reset-password'
  );
  if (!reset) throw new Error('users reset-password is missing from the catalog');

  const result = buildInvocation(reset, draftsFromText(reset, '--logout bob'), '!admin ');
  expect(result.ok && result.body).toBe('!admin users reset-password --logout bob');
});

test('until the catalog loads only the prefix completes', async () => {
  expect(adminSuggestions('!ad', 'adminRoom', null).map((item) => item.label)).toEqual(['!admin']);
  expect(adminSuggestions('!admin ', 'adminRoom', null)).toEqual([]);
  expect(await loadAdminCommands()).toBe(catalog.commands);
});

test('commands the server advertises complete like the catalog', () => {
  const advertised = parseBotCommands(
    ['users reset-password', 'users create', 'rooms list'].map((command) => ({
      sender: adminBot('@alice:example.org'),
      sender_name: null,
      sender_avatar: null,
      content: { command, description: { 'm.text': [{ body: `${command} help` }] } },
    }))
  );
  const tree = adminCommandTree(advertised);

  expect(adminBot('@alice:example.org')).toBe('@conduit:example.org');
  expect(adminSuggestions('!admin us', 'adminRoom', tree).map((item) => item.id)).toEqual([
    '!admin users',
  ]);
  expect(adminSuggestions('!admin users ', 'adminRoom', tree)).toEqual([
    { id: '!admin users create', insert: 'create', label: 'create', detail: 'users create help' },
    {
      id: '!admin users reset-password',
      insert: 'reset-password',
      label: 'reset-password',
      detail: 'users reset-password help',
    },
  ]);
});
