import { expect, test, vi } from 'vitest';

import type { MemberView } from '#src/generated/MemberView';
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
    sendRawEvent: vi.fn(() => Promise.resolve()),
    roomStateEvent: vi.fn(() => Promise.resolve<unknown>({ membership: 'join' })),
    sendStateEvent: vi.fn(() => Promise.resolve()),
    personas: vi.fn(() =>
      Promise.resolve({ personas: [], account: null, rooms: {} } as PersonaCatalogView)
    ),
    savePersona: vi.fn(() => Promise.resolve<PersonaView[]>([])),
    removePersona: vi.fn(() => Promise.resolve<PersonaView[]>([])),
    setPersonaSelection: vi.fn(() => Promise.resolve()),
    accountData: vi.fn(() => Promise.resolve<unknown>(null)),
    setAccountData: vi.fn(() => Promise.resolve()),
    bulkRedact: vi.fn<
      (
        roomId: string,
        senders: string[],
        afterTs: number,
        eventTypes: string[],
        reason: string | null
      ) => Promise<number>
    >(() => Promise.resolve(0)),
    roomMembers: vi.fn(() => Promise.resolve<MemberView[]>([])),
  };
}

function context(commands: ReturnType<typeof fakeCommands>): SlashContext {
  return { roomId: '!room:example.org', userId: '@me:example.org', developerTools: true, commands };
}

test('plain text is not a command', () => {
  expect(parseSlash('hello')).toEqual({ kind: 'none' });
  expect(parseSlash('and/or')).toEqual({ kind: 'none' });
});

test('/bugreport opens the report flow', async () => {
  await expect(runSlash('/bugreport', context(fakeCommands()))).resolves.toEqual({
    kind: 'bugReport',
  });
  await expect(runSlash('/bugreport details', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.bugreport.usage',
  });
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
    verbatim: true,
  });
  await expect(runSlash('/notice the build broke', commands)).resolves.toEqual({
    kind: 'message',
    body: 'the build broke',
    msgtype: 'notice',
    formatted: null,
    verbatim: true,
  });
});

test('/me carries the formatted body across, without the command name', async () => {
  const commands = { ...context(fakeCommands()), formatted: '/me waves <strong>hard</strong>' };

  await expect(runSlash('/me waves **hard**', commands)).resolves.toEqual({
    kind: 'message',
    body: 'waves **hard**',
    msgtype: 'emote',
    formatted: 'waves <strong>hard</strong>',
    verbatim: true,
  });
});

test('a decorated command appends its suffix to the formatted body too', async () => {
  const commands = { ...context(fakeCommands()), formatted: '/shrug <em>oh well</em>' };

  await expect(runSlash('/shrug *oh well*', commands)).resolves.toMatchObject({
    body: '*oh well* ¯\\_(ツ)_/¯',
    formatted: '<em>oh well</em> ¯\\_(ツ)_/¯',
    verbatim: true,
  });
});

test('a formatted body whose command name is buried is dropped rather than mangled', async () => {
  const commands = { ...context(fakeCommands()), formatted: '<strong>/me</strong> waves' };

  await expect(runSlash('/me waves', commands)).resolves.toMatchObject({ formatted: null });
});

test('/gif returns a picker action instead of sending text', async () => {
  await expect(runSlash('/gif cats', context(fakeCommands()))).resolves.toEqual({
    kind: 'gifSearch',
    query: 'cats',
  });
});

test.each([
  ['hug', 'im.fluffychat.cute_event', { cute_type: 'hug', body: '🤗' }],
  ['cuddle', 'im.fluffychat.cute_event', { cute_type: 'cuddle', body: '😊' }],
  ['wave', 'im.fluffychat.cute_event', { cute_type: 'wave', body: '👋' }],
  ['poke', 'im.fluffychat.cute_event', { cute_type: 'poke', body: '🫵' }],
] as const)('/%s sends a raw cute event', async (name, eventType, content) => {
  const commands = fakeCommands();

  await runSlash(`/${name} @someone:example.org`, context(commands));

  expect(commands.sendRawEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'm.room.message',
    expect.objectContaining({ ...content, 'm.mentions': { user_ids: ['@someone:example.org'] } })
  );
});

test('/headpat sends a raw emote event', async () => {
  const commands = fakeCommands();

  await runSlash('/headpat @someone:example.org', context(commands));

  expect(commands.sendRawEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'm.room.message',
    expect.objectContaining({
      msgtype: 'm.emote',
      body: 'pats @someone:example.org',
      'fyi.cisnt.headpat': true,
    })
  );
});

test('/rawmsg sends a raw message event', async () => {
  const commands = fakeCommands();

  await runSlash('/rawmsg {"msgtype":"m.text","body":"hello"}', context(commands));

  expect(commands.sendRawEvent).toHaveBeenCalledWith('!room:example.org', 'm.room.message', {
    msgtype: 'm.text',
    body: 'hello',
  });
});

test('/raw sends either a message or state event', async () => {
  const commands = fakeCommands();

  await runSlash('/raw m.room.test {"value":1}', context(commands));
  await runSlash('/raw m.room.topic {"topic":"new"} -s key', context(commands));

  expect(commands.sendRawEvent).toHaveBeenCalledWith('!room:example.org', 'm.room.test', {
    value: 1,
  });
  expect(commands.sendStateEvent).toHaveBeenCalledWith('!room:example.org', 'm.room.topic', 'key', {
    topic: 'new',
  });
});

test('/rawacc merges and /delacc removes global account data', async () => {
  const commands = fakeCommands();
  commands.accountData.mockResolvedValue({ old: true, remove: true });

  await runSlash('/rawacc com.example.data {"new":1}', context(commands));
  await runSlash('/delacc com.example.data remove', context(commands));

  expect(commands.setAccountData).toHaveBeenNthCalledWith(1, 'com.example.data', {
    old: true,
    remove: true,
    new: 1,
  });
  expect(commands.setAccountData).toHaveBeenNthCalledWith(2, 'com.example.data', {
    old: true,
  });
});

test('developer slash commands require developer controls', async () => {
  await expect(
    runSlash('/rawmsg {}', { ...context(fakeCommands()), developerTools: false })
  ).rejects.toMatchObject({
    key: 'composer.slashDeveloperOnly',
  });
});

test('/delete parses senders, age, event types, and reason', async () => {
  const commands = fakeCommands();
  const now = Date.now();

  await runSlash(
    '/delete @someone:example.org -past 5m -t m.room.message m.room.encrypted -r spam',
    context(commands)
  );

  expect(commands.bulkRedact).toHaveBeenCalledWith(
    '!room:example.org',
    ['@someone:example.org'],
    expect.any(Number),
    ['m.room.message', 'm.room.encrypted'],
    'spam'
  );
  expect(commands.bulkRedact.mock.calls[0]?.[2]).toBeGreaterThanOrEqual(now - 5 * 60 * 1000);
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

test('/acl merges and removes server rules', async () => {
  const commands = fakeCommands();
  commands.roomStateEvent.mockResolvedValueOnce({
    allow: ['good.example'],
    deny: ['bad.example'],
    allow_ip_literals: false,
  });

  await runSlash('/acl -a new.example -d worse.example -ra good.example', context(commands));

  expect(commands.sendStateEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'm.room.server_acl',
    '',
    { allow: ['new.example'], deny: ['bad.example', 'worse.example'], allow_ip_literals: false }
  );
});

test('/addwidget sends a validated widget state event', async () => {
  const commands = fakeCommands();

  await runSlash('/addwidget https://widget.example/app Room Widget', context(commands));

  expect(commands.sendStateEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'im.vector.modular.widgets',
    expect.any(String),
    expect.objectContaining({
      type: 'm.custom',
      url: 'https://widget.example/app',
      name: 'Room Widget',
      creatorUserId: '@me:example.org',
    })
  );
});

test('/pmpproxy appends a persona trigger', async () => {
  const commands = fakeCommands();
  const persona = {
    id: 'alt',
    display_name: 'Alt',
    avatar_url: null,
    pronouns: [],
    color_on_light: null,
    color_on_dark: null,
    triggers: [],
    pluralkit: null,
  } satisfies PersonaView;
  commands.personas.mockResolvedValueOnce({ personas: [persona], account: null, rooms: {} });

  await runSlash('/pmpproxy alt ✨:text', context(commands));

  expect(commands.savePersona).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'alt',
      triggers: [{ prefix: '✨:', suffix: null, keep_trigger: false }],
    }),
    'alt'
  );
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

function member(userId: string, membership: MemberView['membership'] = 'join'): MemberView {
  return { user_id: userId, display_name: null, avatar_url: null, power_level: 0, membership };
}

test.each([
  [
    'color',
    'moe.sable.room.cosmetics.color',
    '#ff00ff',
    { on_dark: '#ff00ff', on_light: '#ff00ff' },
  ],
  ['font', 'moe.sable.room.cosmetics.font', 'Courier New', { font: 'Courier New' }],
  [
    'pronoun',
    'moe.sable.room.cosmetics.pronouns',
    'they/them',
    { pronouns: [{ summary: 'they/them' }] },
  ],
] as const)(
  '/%s sets a cosmetic state event for yourself',
  async (name, eventType, value, content) => {
    const commands = fakeCommands();

    await runSlash(`/${name} ${value}`, context(commands));

    expect(commands.sendStateEvent).toHaveBeenCalledWith(
      '!room:example.org',
      eventType,
      '@me:example.org',
      content
    );

    await runSlash(`/${name} reset`, context(commands));
    expect(commands.sendStateEvent).toHaveBeenLastCalledWith(
      '!room:example.org',
      eventType,
      '@me:example.org',
      {}
    );
  }
);

test('/color rejects anything that is not a hex colour', async () => {
  await expect(runSlash('/color blue', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.color.usage',
  });
});

test('/pronoun understands a language-tagged list', async () => {
  const commands = fakeCommands();

  await runSlash('/pronoun en:they/them, de:sie/ihr', context(commands));

  expect(commands.sendStateEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'moe.sable.room.cosmetics.pronouns',
    '@me:example.org',
    {
      pronouns: [
        { language: 'en', summary: 'they/them' },
        { language: 'de', summary: 'sie/ihr' },
      ],
    }
  );
});

test.each([
  [
    'scolor',
    'moe.sable.room.cosmetics.color',
    '#00ff00',
    { on_dark: '#00ff00', on_light: '#00ff00' },
  ],
  ['sfont', 'moe.sable.room.cosmetics.font', 'Comic Sans', { font: 'Comic Sans' }],
  [
    'spronoun',
    'moe.sable.room.cosmetics.pronouns',
    'she/her',
    { pronouns: [{ summary: 'she/her' }] },
  ],
] as const)(
  '/%s sets a cosmetic state event for someone else',
  async (name, eventType, value, content) => {
    const commands = fakeCommands();

    await runSlash(`/${name} @someone:example.org ${value}`, context(commands));

    expect(commands.sendStateEvent).toHaveBeenCalledWith(
      '!room:example.org',
      eventType,
      '@someone:example.org',
      content
    );

    await expect(runSlash(`/${name} notauser ${value}`, context(commands))).rejects.toMatchObject({
      key: `composer.slash.${name}.usage`,
    });
  }
);

test('/kick expands a server wildcard to matching members, excluding the already-banned', async () => {
  const commands = fakeCommands();
  commands.roomMembers.mockResolvedValueOnce([
    member('@one:evil.example'),
    member('@two:evil.example'),
    member('@three:good.example'),
    member('@banned:evil.example', 'ban'),
  ]);

  await runSlash('/kick @*:evil.example spamming', context(commands));

  expect(commands.kickUser).toHaveBeenCalledTimes(2);
  expect(commands.kickUser).toHaveBeenCalledWith(
    '!room:example.org',
    '@one:evil.example',
    'spamming'
  );
  expect(commands.kickUser).toHaveBeenCalledWith(
    '!room:example.org',
    '@two:evil.example',
    'spamming'
  );
  expect(commands.roomMembers).toHaveBeenCalledWith('!room:example.org');
});

test('/ban expands a server wildcard to matching members, including the already-banned', async () => {
  const commands = fakeCommands();
  commands.roomMembers.mockResolvedValueOnce([
    member('@one:evil.example'),
    member('@banned:evil.example', 'ban'),
  ]);

  await runSlash('/ban @*:evil.example spamming', context(commands));

  expect(commands.banUser).toHaveBeenCalledTimes(2);
  expect(commands.banUser).toHaveBeenCalledWith(
    '!room:example.org',
    '@one:evil.example',
    'spamming'
  );
  expect(commands.banUser).toHaveBeenCalledWith(
    '!room:example.org',
    '@banned:evil.example',
    'spamming'
  );
});

test.each(['kick', 'ban'])(
  '/%s reports a wildcard matching nobody as an error, not a no-op',
  async (name) => {
    const commands = fakeCommands();
    commands.roomMembers.mockResolvedValueOnce([member('@one:good.example')]);

    await expect(runSlash(`/${name} @*:evil.example`, context(commands))).rejects.toMatchObject({
      key: 'composer.slashWildcardEmpty',
      values: { server: 'evil.example' },
    });
    expect(commands[name === 'kick' ? 'kickUser' : 'banUser']).not.toHaveBeenCalled();
  }
);

test('/kick can mix explicit users and a wildcard, deduplicated, with a trailing reason', async () => {
  const commands = fakeCommands();
  commands.roomMembers.mockResolvedValueOnce([
    member('@one:evil.example'),
    member('@two:evil.example'),
  ]);

  await runSlash('/kick @one:evil.example @*:evil.example being rude', context(commands));

  expect(commands.kickUser).toHaveBeenCalledTimes(2);
  expect(commands.kickUser).toHaveBeenCalledWith(
    '!room:example.org',
    '@one:evil.example',
    'being rude'
  );
  expect(commands.kickUser).toHaveBeenCalledWith(
    '!room:example.org',
    '@two:evil.example',
    'being rude'
  );
});

test('/delete expands a server wildcard to matching senders', async () => {
  const commands = fakeCommands();
  commands.roomMembers.mockResolvedValueOnce([
    member('@one:evil.example'),
    member('@two:evil.example'),
  ]);

  await runSlash('/delete @*:evil.example -past 1d', context(commands));

  expect(commands.bulkRedact).toHaveBeenCalledWith(
    '!room:example.org',
    expect.arrayContaining(['@one:evil.example', '@two:evil.example']),
    expect.any(Number),
    [],
    null
  );
});

test('/delete reports a wildcard matching nobody as an error', async () => {
  const commands = fakeCommands();
  commands.roomMembers.mockResolvedValueOnce([]);

  await expect(
    runSlash('/delete @*:evil.example -past 1d', context(commands))
  ).rejects.toMatchObject({
    key: 'composer.slashWildcardEmpty',
    values: { server: 'evil.example' },
  });
  expect(commands.bulkRedact).not.toHaveBeenCalled();
});
