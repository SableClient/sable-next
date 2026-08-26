import { expect, test, vi } from 'vitest';

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
  };
}

function context(commands: ReturnType<typeof fakeCommands>): SlashContext {
  return { roomId: '!room:example.org', commands };
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
  });
  await expect(runSlash('/notice the build broke', commands)).resolves.toEqual({
    kind: 'message',
    body: 'the build broke',
    msgtype: 'notice',
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
