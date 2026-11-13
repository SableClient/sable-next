import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { BotCommand } from '#src/generated/protocol';

import { addPolicy, removePolicy } from './meowlnir-commands';

const ROOM = '!management:example.org';
const BOT = '@meowlnir:example.org';

const text = { schema_type: 'primitive', type: 'string' } as const;
const ban: BotCommand = {
  sender: BOT,
  sender_name: 'Meowlnir',
  sender_avatar: null,
  command: 'ban',
  aliases: [],
  description: null,
  parameters: [
    {
      key: 'list',
      schema: text,
      description: null,
      optional: false,
      default_value: null,
      flag: null,
    },
    {
      key: 'entity',
      schema: text,
      description: null,
      optional: false,
      default_value: null,
      flag: null,
    },
    {
      key: 'reason',
      schema: text,
      description: null,
      optional: true,
      default_value: null,
      flag: null,
    },
  ],
  tail_parameter: 'reason',
};

const send = vi.fn(() => Promise.resolve(null));
const botCommands = vi.fn<() => Promise<BotCommand[]>>();
const core = {
  rpc: { messages: { send }, room_state: { botCommands } },
} as unknown as CoreClient;

beforeEach(() => {
  vi.clearAllMocks();
});

test('a bot that describes its commands gets the structured form and a mention', async () => {
  botCommands.mockResolvedValue([ban]);

  await addPolicy(core, ROOM, 'ban', 'spam', '@bad:example.org', 'posting spam links');

  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      room_id: ROOM,
      body: '!ban spam @bad:example.org posting spam links',
      mentions: [BOT],
      bot_command: {
        command: 'ban',
        arguments: { list: 'spam', entity: '@bad:example.org', reason: 'posting spam links' },
      },
    })
  );
});

test('a bot that describes nothing still gets a command it understands', async () => {
  botCommands.mockResolvedValue([]);

  await addPolicy(core, ROOM, 'unban', 'spam', '@good:example.org', '');
  await removePolicy(core, ROOM, 'spam', '@bad:example.org');

  expect(send).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ body: '!add-unban spam @good:example.org', bot_command: null })
  );
  expect(send).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ body: '!remove-policy spam @bad:example.org', mentions: [] })
  );
});

test('the command is still sent when the descriptions cannot be read', async () => {
  botCommands.mockRejectedValue(new Error('offline'));

  await addPolicy(core, ROOM, 'takedown', 'spam', 'evil.example', 'raid');

  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ body: '!takedown spam evil.example raid' })
  );
});
