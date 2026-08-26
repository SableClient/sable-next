import { expect, test, vi } from 'vitest';

import type { PersonaCatalogView } from '#src/generated/PersonaCatalogView';
import type { PersonaView } from '#src/generated/PersonaView';

import {
  descriptionKey,
  parseSlash,
  runSlash,
  SLASH_COMMANDS,
  SlashError,
  usageKey,
  type SlashContext,
} from './slash-commands';

import en from '../../../locales/en.json' with { type: 'json' };

function fakeCommands() {
  return {
    banUser: vi.fn(() => Promise.resolve()),
    inviteUser: vi.fn(() => Promise.resolve()),
    joinRoom: vi.fn(() => Promise.resolve('!joined:example.org')),
    kickUser: vi.fn(() => Promise.resolve()),
    knockRoom: vi.fn(() => Promise.resolve('!knocked:example.org')),
    leaveRoom: vi.fn(() => Promise.resolve()),
    setDisplayName: vi.fn(() => Promise.resolve()),
    setRoomName: vi.fn(() => Promise.resolve()),
    setRoomTopic: vi.fn(() => Promise.resolve()),
    unbanUser: vi.fn(() => Promise.resolve()),
    createDm: vi.fn(() => Promise.resolve('!dm:example.org')),
    ignoreUser: vi.fn(() => Promise.resolve()),
    unignoreUser: vi.fn(() => Promise.resolve()),
    setDirect: vi.fn(() => Promise.resolve()),
    sendLocation: vi.fn(() => Promise.resolve()),
    roomStateEvent: vi.fn(() => Promise.resolve<unknown>({ membership: 'join' })),
    sendStateEvent: vi.fn(() => Promise.resolve()),
    personas: vi.fn(() =>
      Promise.resolve({ personas: [], account: null, rooms: {} } as PersonaCatalogView)
    ),
    savePersona: vi.fn(() => Promise.resolve<PersonaView[]>([])),
    removePersona: vi.fn(() => Promise.resolve<PersonaView[]>([])),
    setPersonaSelection: vi.fn(() => Promise.resolve()),
  };
}

function context(commands: ReturnType<typeof fakeCommands>): SlashContext {
  return { roomId: '!room:example.org', userId: '@me:example.org', commands };
}

test('plain text is not a command', () => {
  expect(parseSlash('hello')).toEqual({ kind: 'none' });
  expect(parseSlash('and/or')).toEqual({ kind: 'none' });
});

test('a doubled slash escapes a message that starts with one', async () => {
  expect(parseSlash('//me is literal')).toEqual({ kind: 'literal', body: '/me is literal' });

  await expect(runSlash('//me is literal', context(fakeCommands()))).resolves.toEqual({
    kind: 'message',
    body: '/me is literal',
    msgtype: 'text',
    formatted: null,
  });
});

test('the command name is matched without regard to case', () => {
  const parsed = parseSlash('/ME waves');

  expect(parsed).toMatchObject({ kind: 'command', args: 'waves' });
});

test('an unknown command is reported rather than sent', async () => {
  await expect(runSlash('/nope', context(fakeCommands()))).rejects.toThrow(SlashError);
  await expect(runSlash('/nope', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slashUnknown',
    values: { name: 'nope' },
  });
});

test('/me and /notice change the msgtype and nothing else', async () => {
  const commands = context(fakeCommands());

  await expect(runSlash('/me waves', commands)).resolves.toEqual({
    kind: 'message',
    body: 'waves',
    msgtype: 'emote',
    formatted: null,
  });
  await expect(runSlash('/notice the build broke', commands)).resolves.toEqual({
    kind: 'message',
    body: 'the build broke',
    msgtype: 'notice',
    formatted: null,
  });
});

test('/me with nothing to say reports its usage', async () => {
  await expect(runSlash('/me', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.me.usage',
  });
  await expect(runSlash('/me    ', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.me.usage',
  });
});

test('/shrug appends to what was typed, or stands alone', async () => {
  const commands = context(fakeCommands());

  await expect(runSlash('/shrug who knows', commands)).resolves.toMatchObject({
    body: 'who knows ¯\\_(ツ)_/¯',
    msgtype: 'text',
  });
  await expect(runSlash('/shrug', commands)).resolves.toMatchObject({
    body: '¯\\_(ツ)_/¯',
  });
});

test('/join takes an address and its routing servers', async () => {
  const commands = fakeCommands();

  await expect(
    runSlash('/join https://matrix.to/#/%23room%3Aexample.org?via=other.org', context(commands))
  ).resolves.toEqual({ kind: 'done' });
  expect(commands.joinRoom).toHaveBeenCalledWith('#room:example.org', ['other.org']);
});

test('/join rejects something that is not an address', async () => {
  await expect(runSlash('/join not-a-room', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.join.usage',
  });
});

test('/knock passes the reason on, and omits it when absent', async () => {
  const commands = fakeCommands();

  await runSlash('/knock #room:example.org let me in', context(commands));
  expect(commands.knockRoom).toHaveBeenCalledWith('#room:example.org', [], 'let me in');

  await runSlash('/knock #room:example.org', context(commands));
  expect(commands.knockRoom).toHaveBeenLastCalledWith('#room:example.org', [], undefined);
});

test('/leave takes no arguments', async () => {
  const commands = fakeCommands();

  await runSlash('/leave', context(commands));
  expect(commands.leaveRoom).toHaveBeenCalledWith('!room:example.org');

  await expect(runSlash('/leave now', context(commands))).rejects.toMatchObject({
    key: 'composer.slash.leave.usage',
  });
});

test.each([
  ['kick', 'kickUser'],
  ['ban', 'banUser'],
  ['unban', 'unbanUser'],
] as const)('/%s takes a user and a reason', async (name, method) => {
  const commands = fakeCommands();

  await runSlash(`/${name} @someone:example.org spamming the room`, context(commands));
  expect(commands[method]).toHaveBeenCalledWith(
    '!room:example.org',
    '@someone:example.org',
    'spamming the room'
  );

  await runSlash(`/${name} @someone:example.org`, context(commands));
  expect(commands[method]).toHaveBeenLastCalledWith(
    '!room:example.org',
    '@someone:example.org',
    null
  );
});

test.each(['kick', 'ban', 'unban', 'invite'])(
  '/%s rejects something that is not a user id',
  async (name) => {
    await expect(runSlash(`/${name} someone`, context(fakeCommands()))).rejects.toMatchObject({
      key: `composer.slash.${name}.usage`,
    });
  }
);

test('/invite refuses a reason it cannot deliver', async () => {
  const commands = fakeCommands();

  await runSlash('/invite @someone:example.org', context(commands));
  expect(commands.inviteUser).toHaveBeenCalledWith('!room:example.org', '@someone:example.org');

  await expect(
    runSlash('/invite @someone:example.org come join', context(commands))
  ).rejects.toMatchObject({ key: 'composer.slash.invite.usage' });
});

test.each([
  ['nick', 'setDisplayName', ['Marie']],
  ['roomname', 'setRoomName', ['!room:example.org', 'The Lounge']],
  ['topic', 'setRoomTopic', ['!room:example.org', 'The Lounge']],
] as const)('/%s writes the text it was given', async (name, method, expected) => {
  const commands = fakeCommands();
  const text = name === 'nick' ? 'Marie' : 'The Lounge';

  await runSlash(`/${name} ${text}`, context(commands));
  expect(commands[method]).toHaveBeenCalledWith(...expected);

  await expect(runSlash(`/${name}`, context(commands))).rejects.toMatchObject({
    key: `composer.slash.${name}.usage`,
  });
});

test('every command has a description and a usage line', () => {
  const slash: Record<string, { description: string; usage: string }> = en.composer.slash;

  for (const command of SLASH_COMMANDS) {
    const entry = slash[command.name];
    expect(entry, `no locale entry for /${command.name}`).toBeDefined();
    expect(descriptionKey(command)).toBe(`composer.slash.${command.name}.description`);
    expect(usageKey(command)).toBe(`composer.slash.${command.name}.usage`);
    expect(entry.description.length, `/${command.name} description`).toBeGreaterThan(0);
    expect(entry.usage.startsWith(`/${command.name}`), `/${command.name} usage`).toBe(true);
  }
});

test('no two commands claim the same name', () => {
  const names = SLASH_COMMANDS.map((command) => command.name);

  expect(new Set(names).size).toBe(names.length);
});

test.each([
  ['disinvite', 'kickUser'],
  ['ignore', 'ignoreUser'],
  ['unignore', 'unignoreUser'],
  ['startdm', 'createDm'],
] as const)('/%s acts on every user id it was given, once each', async (name, method) => {
  const commands = fakeCommands();

  await runSlash(`/${name} @one:example.org @two:example.org @one:example.org`, context(commands));

  expect(commands[method]).toHaveBeenCalledTimes(2);
  await expect(runSlash(`/${name} nobody`, context(commands))).rejects.toMatchObject({
    key: `composer.slash.${name}.usage`,
  });
});

test('/converttodm and /converttoroom flip the direct flag', async () => {
  const commands = fakeCommands();

  await runSlash('/converttodm', context(commands));
  expect(commands.setDirect).toHaveBeenCalledWith('!room:example.org', true);

  await runSlash('/converttoroom', context(commands));
  expect(commands.setDirect).toHaveBeenLastCalledWith('!room:example.org', false);
});

test('/html sends the markup and a stripped plain-text body', async () => {
  const outcome = await runSlash(
    '/html <b>bold</b><br>and <a href="https://example.org">a link</a>',
    context(fakeCommands())
  );

  expect(outcome).toEqual({
    kind: 'message',
    msgtype: 'text',
    body: 'bold\nand a link (https://example.org)',
    formatted: '<b>bold</b><br>and <a href="https://example.org">a link</a>',
  });
});

test('/rainbow colours every visible character and escapes the text', async () => {
  const outcome = await runSlash('/rainbow a<b', context(fakeCommands()));

  expect(outcome.kind).toBe('message');
  if (outcome.kind !== 'message') return;
  expect(outcome.body).toBe('a<b');
  expect(outcome.formatted).toContain('&lt;');
  expect(outcome.formatted?.match(/data-mx-color/g)).toHaveLength(3);
});

test('/rainbowme is an emote', async () => {
  const outcome = await runSlash('/rainbowme waves', context(fakeCommands()));

  expect(outcome).toMatchObject({ msgtype: 'emote', body: 'waves' });
});

test('/location sends the coordinates it parsed', async () => {
  const commands = fakeCommands();

  await runSlash('/location 48.8584 2.2945', context(commands));

  expect(commands.sendLocation).toHaveBeenCalledWith(
    '!room:example.org',
    '48.8584,2.2945',
    'geo:48.8584,2.2945'
  );
});

test.each(['/location 91 0', '/location 1', '/location 1 2 3', '/location a b'])(
  '%s does not send',
  async (input) => {
    const commands = fakeCommands();

    await expect(runSlash(input, context(commands))).rejects.toMatchObject({
      key: 'composer.slash.location.usage',
    });
    expect(commands.sendLocation).not.toHaveBeenCalled();
  }
);

test('/myroomnick merges into the existing member state', async () => {
  const commands = fakeCommands();
  commands.roomStateEvent.mockResolvedValueOnce({
    membership: 'join',
    avatar_url: 'mxc://example.org/keep',
  });

  await runSlash('/myroomnick Marie', context(commands));

  expect(commands.sendStateEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'm.room.member',
    '@me:example.org',
    { membership: 'join', avatar_url: 'mxc://example.org/keep', displayname: 'Marie' }
  );
});

test('/myroomavatar insists on an mxc uri', async () => {
  const commands = fakeCommands();

  await expect(
    runSlash('/myroomavatar https://example.org/pic.png', context(commands))
  ).rejects.toMatchObject({ key: 'composer.slash.myroomavatar.usage' });
  expect(commands.sendStateEvent).not.toHaveBeenCalled();

  await runSlash('/myroomavatar mxc://example.org/pic', context(commands));
  expect(commands.sendStateEvent).toHaveBeenCalled();
});

test('a per-room profile command needs to know who we are', async () => {
  const commands = fakeCommands();

  await expect(
    runSlash('/myroomnick Marie', { ...context(commands), userId: null })
  ).rejects.toMatchObject({ key: 'composer.slash.myroomnick.usage' });
});

test('/addpmp creates a profile from its named fields', async () => {
  const commands = fakeCommands();

  await runSlash('/addpmp alt name=Alt avatar=mxc://example.org/a', context(commands));

  expect(commands.savePersona).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'alt',
      display_name: 'Alt',
      avatar_url: 'mxc://example.org/a',
    }),
    null
  );
});

test('/addpmp refuses the reserved id and a non-mxc avatar', async () => {
  const commands = fakeCommands();

  for (const input of ['/addpmp index', '/addpmp alt avatar=https://example.org/a']) {
    await expect(runSlash(input, context(commands))).rejects.toMatchObject({
      key: 'composer.slash.addpmp.usage',
    });
  }
  expect(commands.savePersona).not.toHaveBeenCalled();
});

test('/delpmp removes by id but never the index', async () => {
  const commands = fakeCommands();

  await runSlash('/delpmp alt', context(commands));
  expect(commands.removePersona).toHaveBeenCalledWith('alt');

  await expect(runSlash('/delpmp index', context(commands))).rejects.toMatchObject({
    key: 'composer.slash.delpmp.usage',
  });
});

test('/usepmp latches a profile and resets it', async () => {
  const commands = fakeCommands();

  await runSlash('/usepmp alt', context(commands));
  expect(commands.setPersonaSelection).toHaveBeenCalledWith('!room:example.org', 'alt', null);

  await runSlash('/usepmp alt 1700000000000', context(commands));
  expect(commands.setPersonaSelection).toHaveBeenLastCalledWith(
    '!room:example.org',
    'alt',
    1_700_000_000_000
  );

  await runSlash('/usepmp reset', context(commands));
  expect(commands.setPersonaSelection).toHaveBeenLastCalledWith('!room:example.org', null);
});
