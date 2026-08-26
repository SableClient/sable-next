import type { MessageKind } from '#src/generated/MessageKind';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { parseJoinAddress } from '#lib/features/room/join-address.js';

export type SlashCommandApi = Pick<
  CoreCommands,
  | 'banUser'
  | 'inviteUser'
  | 'joinRoom'
  | 'kickUser'
  | 'knockRoom'
  | 'leaveRoom'
  | 'setDisplayName'
  | 'setRoomName'
  | 'setRoomTopic'
  | 'unbanUser'
>;

export type SlashContext = {
  roomId: string;
  commands: SlashCommandApi;
};

export type SlashOutcome =
  | { kind: 'message'; body: string; msgtype: MessageKind }
  | { kind: 'done' }
  | { kind: 'error'; key: string; values?: Record<string, string> };

export type SlashCommand = {
  readonly name: string;
  run(args: string, context: SlashContext): SlashOutcome | Promise<SlashOutcome>;
};

export type SlashResult = Exclude<SlashOutcome, { kind: 'error' }>;

export class SlashError extends Error {
  constructor(
    readonly key: string,
    readonly values?: Record<string, string>
  ) {
    super(key);
    this.name = 'SlashError';
  }
}

export type ParsedSlash =
  | { kind: 'command'; command: SlashCommand; args: string }
  | { kind: 'literal'; body: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'none' };

function localeKey(name: string, part: 'description' | 'usage'): string {
  return `composer.slash.${name}.${part}`;
}

export function descriptionKey(command: SlashCommand): string {
  return localeKey(command.name, 'description');
}

export function usageKey(command: SlashCommand): string {
  return localeKey(command.name, 'usage');
}

const USER_ID = /^@[^:\s]+:\S+$/;

function message(body: string, msgtype: MessageKind): SlashOutcome {
  return { kind: 'message', body, msgtype };
}

function usageError(name: string): SlashOutcome {
  return { kind: 'error', key: localeKey(name, 'usage') };
}

function speech(name: string, msgtype: MessageKind): SlashCommand {
  return {
    name,
    run: (args) => {
      const text = args.trim();
      return text === '' ? usageError(name) : message(text, msgtype);
    },
  };
}

function decorated(name: string, suffix: string): SlashCommand {
  return {
    name,
    run: (args) => {
      const text = args.trim();
      return message(text === '' ? suffix : `${text} ${suffix}`, 'text');
    },
  };
}

function splitTargetUser(args: string): { userId: string; reason: string | null } | null {
  const [first, ...rest] = args.trim().split(/\s+/);
  if (!USER_ID.test(first)) return null;

  const reason = rest.join(' ').trim();
  return { userId: first, reason: reason === '' ? null : reason };
}

type ModerationVerb = Extract<keyof SlashCommandApi, 'banUser' | 'kickUser' | 'unbanUser'>;

function moderation(name: string, verb: ModerationVerb): SlashCommand {
  return {
    name,
    run: async (args, { roomId, commands }) => {
      const target = splitTargetUser(args);
      if (target === null) return usageError(name);

      await commands[verb](roomId, target.userId, target.reason);
      return { kind: 'done' };
    },
  };
}

function setter(
  name: string,
  write: (text: string, context: SlashContext) => Promise<void>
): SlashCommand {
  return {
    name,
    run: async (args, context) => {
      const text = args.trim();
      if (text === '') return usageError(name);

      await write(text, context);
      return { kind: 'done' };
    },
  };
}

function address(
  name: string,
  visit: (
    target: { address: string; via: string[] },
    reason: string | null,
    context: SlashContext
  ) => Promise<unknown>
): SlashCommand {
  return {
    name,
    run: async (args, context) => {
      const [first, ...rest] = args.trim().split(/\s+/);
      const target = parseJoinAddress(first);
      if (target === null) return usageError(name);

      const reason = rest.join(' ').trim();
      await visit(target, reason === '' ? null : reason, context);
      return { kind: 'done' };
    },
  };
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  speech('me', 'emote'),
  speech('notice', 'notice'),
  decorated('shrug', '¯\\_(ツ)_/¯'),
  decorated('tableflip', '(╯°□°）╯︵ ┻━┻'),
  decorated('unflip', '┬─┬ ノ( ゜-゜ノ)'),
  address('join', (target, _reason, { commands }) => commands.joinRoom(target.address, target.via)),
  address('knock', (target, reason, { commands }) =>
    commands.knockRoom(target.address, target.via, reason ?? undefined)
  ),
  {
    name: 'leave',
    run: async (args, { roomId, commands }) => {
      if (args.trim() !== '') return usageError('leave');

      await commands.leaveRoom(roomId);
      return { kind: 'done' };
    },
  },
  {
    name: 'invite',
    run: async (args, { roomId, commands }) => {
      const target = splitTargetUser(args);
      if (target === null || target.reason !== null) return usageError('invite');

      await commands.inviteUser(roomId, target.userId);
      return { kind: 'done' };
    },
  },
  moderation('kick', 'kickUser'),
  moderation('ban', 'banUser'),
  moderation('unban', 'unbanUser'),
  setter('nick', (text, { commands }) => commands.setDisplayName(text)),
  setter('roomname', (text, { roomId, commands }) => commands.setRoomName(roomId, text)),
  setter('topic', (text, { roomId, commands }) => commands.setRoomTopic(roomId, text)),
];

const byName = new Map(SLASH_COMMANDS.map((command) => [command.name, command]));

export function parseSlash(body: string): ParsedSlash {
  if (!body.startsWith('/')) return { kind: 'none' };
  if (body.startsWith('//')) return { kind: 'literal', body: body.slice(1) };

  const boundary = body.search(/\s/);
  const name = (boundary === -1 ? body.slice(1) : body.slice(1, boundary)).toLowerCase();
  const args = boundary === -1 ? '' : body.slice(boundary + 1);

  const command = byName.get(name);
  return command === undefined ? { kind: 'unknown', name } : { kind: 'command', command, args };
}

export async function runSlash(body: string, context: SlashContext): Promise<SlashResult> {
  const parsed = parseSlash(body);

  switch (parsed.kind) {
    case 'none':
      return { kind: 'message', body, msgtype: 'text' };
    case 'literal':
      return { kind: 'message', body: parsed.body, msgtype: 'text' };
    case 'unknown':
      throw new SlashError('composer.slashUnknown', { name: parsed.name });
    case 'command': {
      const outcome = await parsed.command.run(parsed.args, context);
      if (outcome.kind === 'error') throw new SlashError(outcome.key, outcome.values);
      return outcome;
    }
  }
}
