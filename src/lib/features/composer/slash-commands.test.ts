// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';

import type {
  FieldEdit,
  MemberLookEdit,
  MemberView,
  PersonaCatalogView,
  PersonaView,
  RoomPreviewView,
  RpcParams,
  ShareHistoryView,
  Rpc,
} from '#src/generated/protocol';

import {
  parseSlash,
  runSlash,
  slashCommandNames,
  SlashError,
  type SlashContext,
} from './slash-commands';

import { testPersona } from '#lib/personas/persona.ts';

function fakeCommands() {
  return {
    banUser: vi.fn(() => Promise.resolve()),
    inviteUser: vi.fn(() => Promise.resolve()),
    joinRoom: vi.fn(() => Promise.resolve('!joined:example.org')),
    kickUser: vi.fn(() => Promise.resolve()),
    knockRoom: vi.fn(() => Promise.resolve('!knocked:example.org')),
    previewRoom: vi.fn(() => Promise.resolve({ join_rule: 'invite' } as RoomPreviewView)),
    leaveRoom: vi.fn(() => Promise.resolve()),
    setDisplayName: vi.fn(() => Promise.resolve(null)),
    unbanUser: vi.fn(() => Promise.resolve()),
    createDm: vi.fn(() => Promise.resolve('!dm:example.org')),
    ignoreUser: vi.fn(() => Promise.resolve(null)),
    unignoreUser: vi.fn(() => Promise.resolve(null)),
    setDirect: vi.fn(() => Promise.resolve(null)),
    sendLocation: vi.fn(() => Promise.resolve(null)),
    sendRawEvent: vi.fn(() => Promise.resolve('$created')),
    setMemberLook: vi.fn((..._args: unknown[]) => Promise.resolve()),
    setPronouns: vi.fn((..._args: unknown[]) => Promise.resolve()),
    sendGesture: vi.fn((..._args: unknown[]) => Promise.resolve(null)),
    data: vi.fn(() => Promise.resolve<unknown>(null)),
    setData: vi.fn(() => Promise.resolve(null)),
    bulkRedact: vi.fn<(params: RpcParams<Rpc['messages']['bulkRedact']>) => Promise<number>>(() =>
      Promise.resolve(0)
    ),
    roomMembers: vi.fn(() => Promise.resolve<MemberView[]>([])),
  };
}

function fakeRpc() {
  return {
    encryption: {
      discardRoomKey: vi.fn(() => Promise.resolve(null)),
      shareHistory: vi.fn(() => Promise.resolve<ShareHistoryView>('shared')),
    },
    room_state: {
      setName: vi.fn(() => Promise.resolve(null)),
      setTopic: vi.fn(() => Promise.resolve(null)),
      sendEvent: vi.fn((..._args: unknown[]) => Promise.resolve('$created')),
      updateServerAcl: vi.fn((..._args: unknown[]) => Promise.resolve(null)),
      addWidget: vi.fn((..._args: unknown[]) => Promise.resolve('widget')),
    },
    personas: {
      list: vi.fn(() =>
        Promise.resolve({
          personas: [],
          account: null,
          rooms: {},
          account_rooms: [],
          disabled_rooms: [],
        } as PersonaCatalogView)
      ),
      save: vi.fn((..._args: unknown[]) => Promise.resolve<PersonaView[]>([])),
      remove: vi.fn((..._args: unknown[]) => Promise.resolve<PersonaView[]>([])),
      setSelection: vi.fn((..._args: unknown[]) => Promise.resolve(null)),
      disableRoom: vi.fn((..._args: unknown[]) => Promise.resolve(null)),
    },
  };
}

const KEEP = { kind: 'keep' } as const;

function look(fields: Partial<MemberLookEdit>): MemberLookEdit {
  return {
    display_name: KEEP,
    avatar_url: KEEP,
    color_on_light: KEEP,
    color_on_dark: KEEP,
    ...fields,
  };
}

function context(
  commands: ReturnType<typeof fakeCommands>,
  rpc: ReturnType<typeof fakeRpc> = fakeRpc()
): SlashContext {
  const { joinRoom, knockRoom, previewRoom, leaveRoom, inviteUser, createDm } = commands;
  const { roomMembers, kickUser, banUser, unbanUser, setMemberLook, setPronouns } = commands;
  return {
    roomId: '!room:example.org',
    userId: '@me:example.org',
    developerTools: true,
    e2eePolicy: () => Promise.resolve({ defaultEncrypted: true, forceDisabled: false }),
    rpc: {
      ...rpc,
      account: commands,
      messages: commands,
      rooms: {
        join: joinRoom,
        knock: knockRoom,
        preview: previewRoom,
        leave: leaveRoom,
        invite: inviteUser,
        createDm,
      },
      members: {
        list: roomMembers,
        kick: kickUser,
        ban: banUser,
        unban: unbanUser,
        setLook: setMemberLook,
        setPronouns,
      },
    } as unknown as SlashContext['rpc'],
  };
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

  expect(parsed).toMatchObject({ kind: 'command', name: 'me' });
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

test.each(['hug', 'cuddle', 'wave', 'poke', 'headpat'] as const)(
  '/%s sends its gesture at the mentioned user',
  async (name) => {
    const commands = fakeCommands();

    await runSlash(`/${name} @someone:example.org`, context(commands));

    expect(commands.sendGesture).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      gesture: name,
      target: '@someone:example.org',
    });
  }
);

test('a mention pill stands in for the user id a command asks for', async () => {
  const commands = fakeCommands();

  await runSlash('/headpat @Kris', {
    ...context(commands),
    formatted: '/headpat <a href="https://matrix.to/#/@kris:example.org">@Kris</a>',
  });

  expect(commands.sendGesture).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    gesture: 'headpat',
    target: '@kris:example.org',
  });
});

test('a gesture without a target is sent at nobody in particular', async () => {
  const commands = fakeCommands();

  await runSlash('/headpat', context(commands));

  expect(commands.sendGesture).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    gesture: 'headpat',
    target: null,
  });
});

test('/rawmsg sends a raw message event', async () => {
  const commands = fakeCommands();

  await runSlash('/rawmsg {"msgtype":"m.text","body":"hello"}', context(commands));

  expect(commands.sendRawEvent).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'hello' },
  });
});

test('/raw sends either a message or state event', async () => {
  const commands = fakeCommands();
  const rpc = fakeRpc();

  await runSlash('/raw m.room.test {"value":1}', context(commands, rpc));
  await runSlash('/raw m.room.topic {"topic":"new"} -s key', context(commands, rpc));

  expect(commands.sendRawEvent).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_type: 'm.room.test',
    content: { value: 1 },
  });
  expect(rpc.room_state.sendEvent).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_type: 'm.room.topic',
    state_key: 'key',
    content: { topic: 'new' },
  });
});

test('/rawacc merges and /delacc removes global account data', async () => {
  const commands = fakeCommands();
  commands.data.mockResolvedValue({ old: true, remove: true });

  await runSlash('/rawacc com.example.data {"new":1}', context(commands));
  await runSlash('/delacc com.example.data remove', context(commands));

  expect(commands.setData).toHaveBeenNthCalledWith(1, {
    event_type: 'com.example.data',
    content: { old: true, remove: true, new: 1 },
  });
  expect(commands.setData).toHaveBeenNthCalledWith(2, {
    event_type: 'com.example.data',
    content: { old: true },
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

  expect(commands.bulkRedact).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    senders: ['@someone:example.org'],
    after_ts: expect.any(Number) as number,
    event_types: ['m.room.message', 'm.room.encrypted'],
    reason: 'spam',
  });
  expect(commands.bulkRedact.mock.calls[0]?.[0].after_ts).toBeGreaterThanOrEqual(
    now - 5 * 60 * 1000
  );
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
  expect(commands.joinRoom).toHaveBeenCalledWith({
    address: '#room:example.org',
    via: ['other.org'],
  });
});

test('/join hands a knock room over to the ask to join page', async () => {
  const commands = fakeCommands();
  commands.joinRoom.mockRejectedValue(new Error('forbidden'));
  commands.previewRoom.mockResolvedValue({ join_rule: 'knock' } as RoomPreviewView);

  await expect(
    runSlash('/join https://matrix.to/#/%23room%3Aexample.org?via=other.org', context(commands))
  ).resolves.toEqual({ kind: 'knock', address: '#room:example.org', via: ['other.org'] });
});

test('/join still fails when the room cannot be knocked on', async () => {
  const commands = fakeCommands();
  commands.joinRoom.mockRejectedValue(new Error('forbidden'));

  await expect(runSlash('/join #room:example.org', context(commands))).rejects.toThrow('forbidden');
});

test('/join rejects something that is not an address', async () => {
  await expect(runSlash('/join not-a-room', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.join.usage',
  });
});

test('/knock passes the reason on, and omits it when absent', async () => {
  const commands = fakeCommands();

  await runSlash('/knock #room:example.org let me in', context(commands));
  expect(commands.knockRoom).toHaveBeenCalledWith({
    address: '#room:example.org',
    via: [],
    reason: 'let me in',
  });

  await runSlash('/knock #room:example.org', context(commands));
  expect(commands.knockRoom).toHaveBeenLastCalledWith({
    address: '#room:example.org',
    via: [],
    reason: null,
  });
});

test('/leave takes no arguments', async () => {
  const commands = fakeCommands();

  await runSlash('/leave', context(commands));
  expect(commands.leaveRoom).toHaveBeenCalledWith({ room_id: '!room:example.org' });

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
  expect(commands[method]).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@someone:example.org',
    reason: 'spamming the room',
  });

  await runSlash(`/${name} @someone:example.org`, context(commands));
  expect(commands[method]).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    user_id: '@someone:example.org',
    reason: null,
  });
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
  expect(commands.inviteUser).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@someone:example.org',
  });

  await expect(
    runSlash('/invite @someone:example.org come join', context(commands))
  ).rejects.toMatchObject({ key: 'composer.slash.invite.usage' });
});

test('/nick writes the text it was given', async () => {
  const commands = fakeCommands();

  await runSlash('/nick Marie', context(commands));
  expect(commands.setDisplayName).toHaveBeenCalledWith({
    name: 'Marie',
    propagate_to: 'unchanged',
  });

  await expect(runSlash('/nick', context(commands))).rejects.toMatchObject({
    key: 'composer.slash.nick.usage',
  });
});

test.each([
  ['roomname', 'setName', { room_id: '!room:example.org', name: 'The Lounge' }],
  ['topic', 'setTopic', { room_id: '!room:example.org', topic: 'The Lounge' }],
] as const)('/%s writes the text it was given', async (name, method, expected) => {
  const rpc = fakeRpc();

  await runSlash(`/${name} The Lounge`, context(fakeCommands(), rpc));
  expect(rpc.room_state[method]).toHaveBeenCalledWith(expected);

  await expect(runSlash(`/${name}`, context(fakeCommands(), rpc))).rejects.toMatchObject({
    key: `composer.slash.${name}.usage`,
  });
});

test('no two commands claim the same name', () => {
  const names = slashCommandNames();

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

test('/converttodm optionally sets its direct-message target', async () => {
  const commands = fakeCommands();

  await runSlash('/converttodm', context(commands));
  expect(commands.setDirect).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    direct: true,
    user_id: null,
  });

  await runSlash('/converttodm @other:example.org', context(commands));
  expect(commands.setDirect).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    direct: true,
    user_id: '@other:example.org',
  });

  await expect(runSlash('/converttodm other', context(commands))).rejects.toMatchObject({
    key: 'composer.slash.converttodm.usage',
  });
  await expect(
    runSlash('/converttodm @one:example.org extra', context(commands))
  ).rejects.toMatchObject({
    key: 'composer.slash.converttodm.usage',
  });
});

test('/converttoroom clears the direct flag', async () => {
  const commands = fakeCommands();

  await runSlash('/converttoroom', context(commands));
  expect(commands.setDirect).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    direct: false,
    user_id: null,
  });
});

test('/discardsession discards the room key', async () => {
  const commands = fakeCommands();
  const rpc = fakeRpc();

  await runSlash('/discardsession', context(commands, rpc));
  expect(rpc.encryption.discardRoomKey).toHaveBeenCalledWith({ room_id: '!room:example.org' });

  await expect(runSlash('/discardsession now', context(commands, rpc))).rejects.toMatchObject({
    key: 'composer.slash.discardsession.usage',
  });
});

test('/sharehistory shares the room history with one user', async () => {
  const rpc = fakeRpc();

  await runSlash('/sharehistory @bob:example.org', context(fakeCommands(), rpc));
  expect(rpc.encryption.shareHistory).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@bob:example.org',
  });

  await expect(runSlash('/sharehistory', context(fakeCommands(), rpc))).rejects.toMatchObject({
    key: 'composer.slash.sharehistory.usage',
  });
});

test('/sharehistory says why nothing was shared', async () => {
  const rpc = fakeRpc();
  rpc.encryption.shareHistory.mockResolvedValue('no_cross_signing');

  await expect(
    runSlash('/sharehistory @bob:example.org', context(fakeCommands(), rpc))
  ).rejects.toMatchObject({ key: 'composer.slashShareHistory.no_cross_signing' });
});

test('/acl hands the flags to the core', async () => {
  const rpc = fakeRpc();

  await runSlash(
    '/acl -a new.example -d worse.example -ra good.example',
    context(fakeCommands(), rpc)
  );

  expect(rpc.room_state.updateServerAcl).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    allow: ['new.example'],
    deny: ['worse.example'],
    remove_allow: ['good.example'],
    remove_deny: [],
  });
});

test('/addwidget names the widget after the rest of the line', async () => {
  const rpc = fakeRpc();

  await runSlash('/addwidget https://widget.example/app Room Widget', context(fakeCommands(), rpc));

  expect(rpc.room_state.addWidget).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    name: 'Room Widget',
    url: 'https://widget.example/app',
  });
});

test('/addwidget shows its usage for a url the core refuses', async () => {
  const rpc = fakeRpc();
  rpc.room_state.addWidget.mockRejectedValueOnce(new CoreError({ code: 'invalid_url' }));

  await expect(
    runSlash('/addwidget javascript:alert(1)', context(fakeCommands(), rpc))
  ).rejects.toMatchObject({ key: 'composer.slash.addwidget.usage' });
});

test('/pmpproxy appends a persona trigger', async () => {
  const rpc = fakeRpc();
  const persona = {
    ...testPersona,
    id: 'alt',
    display_name: 'Alt',
  } satisfies PersonaView;
  rpc.personas.list.mockResolvedValueOnce({
    personas: [persona],
    account: null,
    rooms: {},
    account_rooms: [],
    disabled_rooms: [],
  });

  await runSlash('/pmpproxy alt ✨:text', context(fakeCommands(), rpc));

  expect(rpc.personas.save).toHaveBeenCalledWith({
    persona: expect.objectContaining({
      id: 'alt',
      triggers: [{ prefix: '✨:', suffix: null, keep_trigger: false, alternate_avatar_id: null }],
    }) as unknown,
    base_persona: persona,
    previous_id: 'alt',
  });
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

test('/html decodes entities into the plain-text body', async () => {
  const outcome = await runSlash('/html Fish &amp; Chips &lt;yes&gt;', context(fakeCommands()));

  expect(outcome).toMatchObject({ body: 'Fish & Chips <yes>' });
});

test('/html cannot carry a tag into the plain-text body', async () => {
  const outcome = await runSlash(
    '/html <a href="https://example.org"><script</a>',
    context(fakeCommands())
  );

  expect(outcome.kind).toBe('message');
  if (outcome.kind !== 'message') return;
  expect(outcome.body).not.toContain('<script');
});

test('/rainbow colours every visible character and escapes the text', async () => {
  const outcome = await runSlash('/rainbow a<b', context(fakeCommands()));

  expect(outcome.kind).toBe('message');
  if (outcome.kind !== 'message') return;
  expect(outcome.body).toBe('a<b');
  expect(outcome.formatted).toContain('&lt;');
  expect(outcome.formatted?.match(/data-mx-color/g)).toHaveLength(3);
});

test('/rainbow keeps a custom emote from the formatted body', async () => {
  const emote = '<img data-mx-emoticon src="mxc://x/y" alt=":cat:">';
  const outcome = await runSlash('/rainbow hi :cat:', {
    ...context(fakeCommands()),
    formatted: `/rainbow hi ${emote}`,
  });

  expect(outcome.kind).toBe('message');
  if (outcome.kind !== 'message') return;
  expect(outcome.formatted).toContain('data-mx-emoticon');
  expect(outcome.formatted).toContain('src="mxc://x/y"');
  expect(outcome.formatted).not.toContain(':cat:</span>');
  expect(outcome.formatted?.match(/data-mx-color/g)).toHaveLength(2);
});

test('/rainbowme is an emote', async () => {
  const outcome = await runSlash('/rainbowme waves', context(fakeCommands()));

  expect(outcome).toMatchObject({ msgtype: 'emote', body: 'waves' });
});

test('/location sends the coordinates it parsed', async () => {
  const commands = fakeCommands();

  await runSlash('/location 48.8584 2.2945', context(commands));

  expect(commands.sendLocation).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    body: '48.8584,2.2945',
    geo_uri: 'geo:48.8584,2.2945',
    in_reply_to: null,
    silent_reply: false,
    thread_root: null,
  });
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

test('/myroomnick sets the room display name', async () => {
  const commands = fakeCommands();

  await runSlash('/myroomnick Marie', context(commands));

  expect(commands.setMemberLook).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    in_parent_space: false,
    ...look({ display_name: { kind: 'set', value: 'Marie' } }),
  });
});

test('/myroomavatar insists on an mxc uri', async () => {
  const commands = fakeCommands();

  await expect(
    runSlash('/myroomavatar https://example.org/pic.png', context(commands))
  ).rejects.toMatchObject({ key: 'composer.slash.myroomavatar.usage' });
  expect(commands.setMemberLook).not.toHaveBeenCalled();

  await runSlash('/myroomavatar mxc://example.org/pic', context(commands));
  expect(commands.setMemberLook).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    in_parent_space: false,
    ...look({ avatar_url: { kind: 'set', value: 'mxc://example.org/pic' } }),
  });
});

test('a per-room profile command needs to know who we are', async () => {
  const commands = fakeCommands();

  await expect(
    runSlash('/myroomnick Marie', { ...context(commands), userId: null })
  ).rejects.toMatchObject({ key: 'composer.slash.myroomnick.usage' });
});

test('/addpmp creates a profile from its named fields', async () => {
  const rpc = fakeRpc();

  await runSlash('/addpmp alt name=Alt avatar=mxc://example.org/a', context(fakeCommands(), rpc));

  expect(rpc.personas.save).toHaveBeenCalledWith({
    persona: expect.objectContaining({
      id: 'alt',
      display_name: 'Alt',
      avatar_url: 'mxc://example.org/a',
    }) as unknown,
    base_persona: expect.objectContaining({ id: 'alt' }) as unknown,
    previous_id: null,
  });
});

test('/addpmp refuses the reserved id and a non-mxc avatar', async () => {
  const rpc = fakeRpc();

  for (const input of ['/addpmp index', '/addpmp alt avatar=https://example.org/a']) {
    await expect(runSlash(input, context(fakeCommands(), rpc))).rejects.toMatchObject({
      key: 'composer.slash.addpmp.usage',
    });
  }
  expect(rpc.personas.save).not.toHaveBeenCalled();
});

test('/delpmp removes by id but never the index', async () => {
  const rpc = fakeRpc();

  await runSlash('/delpmp alt', context(fakeCommands(), rpc));
  expect(rpc.personas.remove).toHaveBeenCalledWith({ id: 'alt' });

  await expect(runSlash('/delpmp index', context(fakeCommands(), rpc))).rejects.toMatchObject({
    key: 'composer.slash.delpmp.usage',
  });
});

test('/usepmp latches a profile and resets it', async () => {
  const commands = fakeCommands();
  const rpc = fakeRpc();

  await runSlash('/usepmp alt', context(commands, rpc));
  expect(rpc.personas.setSelection).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    persona_id: 'alt',
    valid_until: null,
  });

  await runSlash('/usepmp alt 1700000000000', context(commands, rpc));
  expect(rpc.personas.setSelection).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    persona_id: 'alt',
    valid_until: 1_700_000_000_000,
  });

  await runSlash('/usepmp reset', context(commands, rpc));
  expect(rpc.personas.setSelection).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    persona_id: null,
    valid_until: null,
  });

  await runSlash('/usepmp off', context(commands, rpc));
  expect(rpc.personas.disableRoom).toHaveBeenCalledWith({ room_id: '!room:example.org' });
});

function member(userId: string, membership: MemberView['membership'] = 'join'): MemberView {
  return {
    user_id: userId,
    display_name: null,
    real_name: null,
    real_avatar_url: null,
    avatar_url: null,
    power_level: 0,
    membership,
    member_ts: null,
    kicked: false,
    service: false,
  };
}

test('/pronoun sets and resets your room pronouns', async () => {
  const commands = fakeCommands();

  await runSlash('/pronoun they/them', context(commands));
  expect(commands.setPronouns).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    pronouns: [{ language: null, summary: 'they/them' }],
    in_parent_space: false,
  });

  await runSlash('/pronoun reset', context(commands));
  expect(commands.setPronouns).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    pronouns: [],
    in_parent_space: false,
  });
});

test('/pronoun understands a language-tagged list', async () => {
  const commands = fakeCommands();

  await runSlash('/pronoun en:they/them, de:sie/ihr', context(commands));

  expect(commands.setPronouns).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    pronouns: [
      { language: 'en', summary: 'they/them' },
      { language: 'de', summary: 'sie/ihr' },
    ],
    in_parent_space: false,
  });
});

test('/spronoun targets the parent space', async () => {
  const commands = fakeCommands();

  await runSlash('/spronoun she/her', context(commands));

  expect(commands.setPronouns).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    pronouns: [{ language: null, summary: 'she/her' }],
    in_parent_space: true,
  });
});

test.each<[string, FieldEdit | undefined, FieldEdit | undefined]>([
  ['#FF00FF', { kind: 'set', value: '#ff00ff' }, { kind: 'set', value: '#ff00ff' }],
  ['reset', { kind: 'clear' }, { kind: 'clear' }],
  ['light #ff00ff', { kind: 'set', value: '#ff00ff' }, undefined],
  ['dark reset', undefined, { kind: 'clear' }],
])('/color %s edits the member colours', async (args, light, dark) => {
  const commands = fakeCommands();

  await runSlash(`/color ${args}`, context(commands));

  expect(commands.setMemberLook).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    in_parent_space: false,
    ...look({
      ...(light && { color_on_light: light }),
      ...(dark && { color_on_dark: dark }),
    }),
  });
});

test('/colour rejects anything that is not a hex colour', async () => {
  await expect(runSlash('/color blue', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.color.usage',
  });
  await expect(runSlash('/color light blue', context(fakeCommands()))).rejects.toMatchObject({
    key: 'composer.slash.color.usage',
  });
});

test.each(['font', 'sfont'])('/%s is no longer supported', async (name) => {
  const rpc = fakeRpc();

  await expect(runSlash(`/${name} Georgia`, context(fakeCommands(), rpc))).rejects.toMatchObject({
    key: 'composer.slashUnknown',
  });
  expect(rpc.room_state.sendEvent).not.toHaveBeenCalled();
});

test('/scolor targets the parent space', async () => {
  const commands = fakeCommands();

  await runSlash('/scolor #ff00ff', context(commands));

  expect(commands.setMemberLook).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    in_parent_space: true,
    ...look({
      color_on_light: { kind: 'set', value: '#ff00ff' },
      color_on_dark: { kind: 'set', value: '#ff00ff' },
    }),
  });
});

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
  expect(commands.kickUser).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@one:evil.example',
    reason: 'spamming',
  });
  expect(commands.kickUser).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@two:evil.example',
    reason: 'spamming',
  });
  expect(commands.roomMembers).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    memberships: [],
  });
});

test('/ban expands a server wildcard to matching members, including the already-banned', async () => {
  const commands = fakeCommands();
  commands.roomMembers.mockResolvedValueOnce([
    member('@one:evil.example'),
    member('@banned:evil.example', 'ban'),
  ]);

  await runSlash('/ban @*:evil.example spamming', context(commands));

  expect(commands.banUser).toHaveBeenCalledTimes(2);
  expect(commands.banUser).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@one:evil.example',
    reason: 'spamming',
  });
  expect(commands.banUser).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@banned:evil.example',
    reason: 'spamming',
  });
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
  expect(commands.kickUser).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@one:evil.example',
    reason: 'being rude',
  });
  expect(commands.kickUser).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    user_id: '@two:evil.example',
    reason: 'being rude',
  });
});

test('/delete expands a server wildcard to matching senders', async () => {
  const commands = fakeCommands();
  commands.roomMembers.mockResolvedValueOnce([
    member('@one:evil.example'),
    member('@two:evil.example'),
  ]);

  await runSlash('/delete @*:evil.example -past 1d', context(commands));

  expect(commands.bulkRedact).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    senders: expect.arrayContaining(['@one:evil.example', '@two:evil.example']) as string[],
    after_ts: expect.any(Number) as number,
    event_types: [],
    reason: null,
  });
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
