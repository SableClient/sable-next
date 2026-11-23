import { describe, expect, test, vi } from 'vitest';

import {
  buildInvocation,
  draftsFromText,
  matchBotCommand,
  parseBotCommand,
  prefillDrafts,
  type BotCommand,
} from './bot-commands';

vi.mock('#lib/platform/diagnostics.js', () => ({
  describePlatform: () => Promise.resolve('macOS 15'),
  issuePlatform: () => Promise.resolve('macOS'),
}));

const BOT = '@bot:example.org';

function described(content: unknown, sender = BOT) {
  return { sender, sender_name: 'Bot', sender_avatar: null, content };
}

const ban = {
  command: 'ban',
  aliases: ['b'],
  description: { 'm.text': [{ body: 'Ban someone' }] },
  parameters: [
    {
      key: 'target_room',
      schema: { schema_type: 'primitive', type: 'room_id' },
      description: { 'm.text': [{ body: 'The room ID' }] },
    },
    { key: 'timeout_seconds', schema: { schema_type: 'primitive', type: 'integer' } },
    {
      key: 'apply_to_policy',
      schema: { schema_type: 'primitive', type: 'boolean' },
      optional: true,
    },
    {
      key: 'target_users',
      schema: { schema_type: 'array', items: { schema_type: 'primitive', type: 'user_id' } },
    },
  ],
};

function command(content: unknown = ban): BotCommand {
  const parsed = parseBotCommand(described(content));
  if (!parsed) throw new Error('fixture did not parse');
  return parsed;
}

describe('parseBotCommand', () => {
  test('reads the command, its aliases, descriptions and parameters', () => {
    const parsed = command();
    expect(parsed.command).toBe('ban');
    expect(parsed.aliases).toEqual(['b']);
    expect(parsed.description).toBe('Ban someone');
    expect(parsed.sender_name).toBe('Bot');
    expect(parsed.parameters.map((parameter) => parameter.key)).toEqual([
      'target_room',
      'timeout_seconds',
      'apply_to_policy',
      'target_users',
    ]);
    expect(parsed.parameters[0].description).toBe('The room ID');
    expect(parsed.parameters[2].optional).toBe(true);
  });

  test('rejects duplicate parameter keys', () => {
    const duplicated = {
      command: 'x',
      parameters: [
        { key: 'a', schema: { schema_type: 'primitive', type: 'string' } },
        { key: 'a', schema: { schema_type: 'primitive', type: 'integer' } },
      ],
    };
    expect(parseBotCommand(described(duplicated))).toBeNull();
  });

  test('rejects unknown types and arrays nested in arrays', () => {
    const unknown = {
      command: 'x',
      parameters: [{ key: 'a', schema: { schema_type: 'primitive', type: 'float' } }],
    };
    const nested = {
      command: 'x',
      parameters: [
        {
          key: 'a',
          schema: {
            schema_type: 'array',
            items: { schema_type: 'array', items: { schema_type: 'primitive', type: 'string' } },
          },
        },
      ],
    };
    expect(parseBotCommand(described(unknown))).toBeNull();
    expect(parseBotCommand(described(nested))).toBeNull();
  });
});

describe('matchBotCommand', () => {
  test('matches a name or alias followed by whitespace', () => {
    const commands = [command(), command({ command: 'rooms add' })];
    expect(matchBotCommand('ban x', commands)?.args).toBe('x');
    expect(matchBotCommand('b x', commands)?.command.command).toBe('ban');
    expect(matchBotCommand('banana', commands)).toBeNull();
    expect(matchBotCommand('rooms add #a:b', commands)?.args).toBe('#a:b');
  });

  test('preserves whitespace after a command for pass-through commands', () => {
    expect(
      matchBotCommand('appservices register\n\nid: meowlnir', [
        command({ command: 'appservices register' }),
      ])
    ).toMatchObject({
      args: 'id: meowlnir',
      raw_args: '\n\nid: meowlnir',
    });
  });
});

describe('buildInvocation', () => {
  test('coerces typed input and sends the bot a structured command', () => {
    const result = buildInvocation(
      command(),
      {
        target_room: 'https://matrix.to/#/!room:example.org?via=second.example.org',
        timeout_seconds: '42',
        apply_to_policy: true,
        target_users: ['@alice:example.org', 'https://matrix.to/#/@bob:example.org'],
      },
      '/',
      'matrix.to'
    );

    expect(result).toEqual({
      kind: 'built',
      invocation: {
        command: 'ban',
        arguments: {
          target_room: { type: 'room_id', id: '!room:example.org', via: ['second.example.org'] },
          timeout_seconds: 42,
          apply_to_policy: true,
          target_users: ['@alice:example.org', '@bob:example.org'],
        },
      },
      body: '/ban !room:example.org 42 --apply-to-policy @alice:example.org @bob:example.org',
    });
  });

  test('writes the body after the prefix it was typed with', () => {
    const say = command({
      command: 'users create',
      parameters: [{ key: 'username', schema: { schema_type: 'primitive', type: 'string' } }],
    });
    const result = buildInvocation(say, { username: 'bob' }, '!admin ', 'matrix.to');
    expect(result.kind === 'built' && result.body).toBe('!admin users create bob');
  });

  test('omits an unset optional boolean and reports what is missing or malformed', () => {
    const result = buildInvocation(
      command(),
      {
        target_room: '',
        target_users: [],
        timeout_seconds: 'soon',
      },
      '/',
      'matrix.to'
    );
    expect(result).toEqual({
      kind: 'invalid',
      errors: { target_room: 'required', timeout_seconds: 'invalid', target_users: 'required' },
    });
  });

  test('prefers a literal over a free-form variant of the same union', () => {
    const mode = command({
      command: 'mode',
      parameters: [
        {
          key: 'mode',
          schema: {
            schema_type: 'union',
            variants: [
              { schema_type: 'primitive', type: 'string' },
              { schema_type: 'literal', value: 42 },
            ],
          },
        },
      ],
    });
    const result = buildInvocation(mode, { mode: '42' }, '/', 'matrix.to');
    expect(result.kind === 'built' && result.invocation.arguments.mode).toBe(42);
  });

  test('builds an event reference from a permalink', () => {
    const quote = command({
      command: 'quote',
      parameters: [{ key: 'event', schema: { schema_type: 'primitive', type: 'event_id' } }],
    });
    const result = buildInvocation(
      quote,
      {
        event: 'https://matrix.to/#/!room:example.org/$event?via=example.org',
      },
      '/',
      'matrix.to'
    );
    expect(result.kind === 'built' && result.invocation.arguments.event).toEqual({
      type: 'event_id',
      id: '!room:example.org',
      event_id: '$event',
      via: ['example.org'],
    });
  });
});

describe('draftsFromText', () => {
  test('fills parameters in order and gives an array the words the rest do not need', () => {
    const drafts = draftsFromText(command(), '!room:example.org 42 --apply-to-policy @a:x @b:x');
    expect(drafts).toEqual({
      target_room: '!room:example.org',
      timeout_seconds: '42',
      apply_to_policy: true,
      target_users: ['@a:x', '@b:x'],
    });
  });

  test('sets optional switches and options by name, never by position', () => {
    const reset = command({
      command: 'users reset-password',
      parameters: [
        { key: 'logout', schema: { schema_type: 'primitive', type: 'boolean' }, optional: true },
        { key: 'username', schema: { schema_type: 'primitive', type: 'string' } },
        { key: 'password', schema: { schema_type: 'primitive', type: 'string' }, optional: true },
        { key: 'max_age', schema: { schema_type: 'primitive', type: 'integer' }, optional: true },
      ],
    });

    expect(draftsFromText(reset, 'bob hunter2')).toEqual({
      logout: false,
      username: 'bob',
      password: 'hunter2',
      max_age: '',
    });
    expect(draftsFromText(reset, '--logout bob --max-age=30')).toEqual({
      logout: true,
      username: 'bob',
      password: '',
      max_age: '30',
    });
    expect(draftsFromText(reset, 'bob --max_age 30 hunter2')).toEqual({
      logout: false,
      username: 'bob',
      password: 'hunter2',
      max_age: '30',
    });
  });

  test('hands the tail parameter the rest of the line', () => {
    const say = command({
      command: 'say',
      'fi.mau.tail_parameter': 'text',
      parameters: [
        { key: 'room', schema: { schema_type: 'primitive', type: 'room_alias' } },
        { key: 'text', schema: { schema_type: 'primitive', type: 'string' } },
      ],
    });
    expect(draftsFromText(say, '#a:b hello  there')).toEqual({
      room: '#a:b',
      text: 'hello  there',
    });
  });

  test('starts from the default value', () => {
    const limit = command({
      command: 'limit',
      parameters: [
        {
          key: 'count',
          schema: { schema_type: 'primitive', type: 'integer' },
          'fi.mau.default_value': 10,
        },
      ],
    });
    expect(draftsFromText(limit, '')).toEqual({ count: '10' });
  });
});

describe('prefillDrafts', () => {
  const issue = command({
    command: 'issue',
    parameters: [
      {
        key: 'environment',
        schema: { schema_type: 'primitive', type: 'string' },
        'moe.sable.prefill': 'environment',
      },
      {
        key: 'platforms',
        schema: {
          schema_type: 'array',
          items: { schema_type: 'union', variants: [{ schema_type: 'literal', value: 'macOS' }] },
        },
        optional: true,
        'moe.sable.prefill': 'platform',
      },
    ],
  });

  test('fills the environment and platform for the user to edit', async () => {
    const drafts = draftsFromText(issue, '');
    await prefillDrafts(issue, drafts, 'example.org');
    expect(drafts.environment).toContain('- OS: macOS 15');
    expect(drafts.environment).toContain('- Homeserver: example.org');
    expect(drafts.platforms).toEqual(['macOS']);
  });

  test('leaves commands without prefill hints alone', async () => {
    const drafts = draftsFromText(command(), '');
    const before = structuredClone(drafts);
    await prefillDrafts(command(), drafts, 'example.org');
    expect(drafts).toEqual(before);
  });

  test('skips a platform the bot does not offer', async () => {
    const linuxOnly = command({
      command: 'issue',
      parameters: [
        {
          key: 'platforms',
          schema: { schema_type: 'union', variants: [{ schema_type: 'literal', value: 'Linux' }] },
          'moe.sable.prefill': 'platform',
        },
      ],
    });
    const drafts = draftsFromText(linuxOnly, '');
    await prefillDrafts(linuxOnly, drafts, 'example.org');
    expect(drafts.platforms).toBe('');
  });

  test('keeps what the user already typed', async () => {
    const drafts = { environment: 'Sable 1.0 on Firefox', platforms: [] };
    await prefillDrafts(issue, drafts, 'example.org');
    expect(drafts.environment).toBe('Sable 1.0 on Firefox');
  });
});
