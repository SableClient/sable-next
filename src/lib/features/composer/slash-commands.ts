import type { MessageKind } from '#src/generated/MessageKind';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { parseJoinAddress } from '#lib/features/room/join-address.js';
import { currentFix } from '#lib/platform/geolocation.js';

import { coordinate, geoUriFor } from './composer-location.js';
import { rainbowHtml } from './rainbow.js';

export type SlashCommandApi = Pick<
  CoreCommands,
  | 'banUser'
  | 'createDm'
  | 'ignoreUser'
  | 'inviteUser'
  | 'joinRoom'
  | 'kickUser'
  | 'knockRoom'
  | 'leaveRoom'
  | 'personas'
  | 'removePersona'
  | 'roomStateEvent'
  | 'savePersona'
  | 'sendLocation'
  | 'sendStateEvent'
  | 'setDirect'
  | 'setDisplayName'
  | 'setPersonaSelection'
  | 'setRoomName'
  | 'setRoomTopic'
  | 'unbanUser'
  | 'unignoreUser'
>;

export type SlashContext = {
  roomId: string;
  userId: string | null;
  commands: SlashCommandApi;
};

export type SlashOutcome =
  | { kind: 'message'; body: string; msgtype: MessageKind; formatted?: string | null }
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
const MXC_URI = /^mxc:\/\/\S+$/;

function words(args: string): string[] {
  const trimmed = args.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

function userIds(args: string): string[] {
  return [...new Set(words(args).filter((word) => USER_ID.test(word)))];
}

function message(
  body: string,
  msgtype: MessageKind,
  formatted: string | null = null
): SlashOutcome {
  return { kind: 'message', body, msgtype, formatted };
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

function eachUser(
  name: string,
  act: (userId: string, context: SlashContext) => Promise<unknown>
): SlashCommand {
  return {
    name,
    run: async (args, context) => {
      const targets = userIds(args);
      if (targets.length === 0) return usageError(name);

      for (const userId of targets) await act(userId, context);
      return { kind: 'done' };
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

function memberProfile(
  name: string,
  patch: (text: string) => Record<string, string> | null
): SlashCommand {
  return {
    name,
    run: async (args, { roomId, userId, commands }) => {
      const text = args.trim();
      if (text === '' || userId === null) return usageError(name);

      const fields = patch(text);
      if (fields === null) return usageError(name);

      const current = await commands.roomStateEvent(roomId, 'm.room.member', userId);
      const existing = typeof current === 'object' && current !== null ? current : {};
      await commands.sendStateEvent(roomId, 'm.room.member', userId, {
        ...existing,
        membership: 'join',
        ...fields,
      });
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
  eachUser('disinvite', (userId, { roomId, commands }) => commands.kickUser(roomId, userId)),
  eachUser('ignore', (userId, { commands }) => commands.ignoreUser(userId)),
  eachUser('unignore', (userId, { commands }) => commands.unignoreUser(userId)),
  eachUser('startdm', (userId, { commands }) => commands.createDm(userId)),
  {
    name: 'converttodm',
    run: async (args, { roomId, commands }) => {
      if (args.trim() !== '') return usageError('converttodm');

      await commands.setDirect(roomId, true);
      return { kind: 'done' };
    },
  },
  {
    name: 'converttoroom',
    run: async (args, { roomId, commands }) => {
      if (args.trim() !== '') return usageError('converttoroom');

      await commands.setDirect(roomId, false);
      return { kind: 'done' };
    },
  },
  {
    name: 'html',
    run: (args) => {
      const html = args.trim();
      return html === '' ? usageError('html') : message(plainTextFrom(html), 'text', html);
    },
  },
  {
    name: 'rainbow',
    run: (args) => {
      const text = args.trim();
      return text === '' ? usageError('rainbow') : message(text, 'text', rainbowHtml(text));
    },
  },
  {
    name: 'rainbowme',
    run: (args) => {
      const text = args.trim();
      return text === '' ? usageError('rainbowme') : message(text, 'emote', rainbowHtml(text));
    },
  },
  {
    name: 'location',
    run: async (args, { roomId, commands }) => {
      const parts = words(args);
      if (parts.length !== 2) return usageError('location');

      const geoUri = geoUriFor(coordinate(parts[0]), coordinate(parts[1]));
      if (geoUri === null) return usageError('location');

      await commands.sendLocation(roomId, geoUri.slice('geo:'.length), geoUri);
      return { kind: 'done' };
    },
  },
  {
    name: 'sharemylocation',
    run: async (args, { roomId, commands }) => {
      if (args.trim() !== '') return usageError('sharemylocation');

      const result = await currentFix();
      if (result.kind !== 'fix') return { kind: 'error', key: `composer.slashFix.${result.kind}` };

      const geoUri = geoUriFor(result.fix.latitude, result.fix.longitude);
      if (geoUri === null) return { kind: 'error', key: 'composer.slashFix.unavailable' };

      await commands.sendLocation(roomId, geoUri.slice('geo:'.length), geoUri);
      return { kind: 'done' };
    },
  },
  memberProfile('myroomnick', (text) => ({ displayname: text })),
  memberProfile('myroomavatar', (text) => (MXC_URI.test(text) ? { avatar_url: text } : null)),
  {
    name: 'addpmp',
    run: async (args, { commands }) => {
      const parts = words(args);
      const id = parts[0];
      if (parts.length === 0 || id === 'index') return usageError('addpmp');

      const fields = new Map<string, string>();
      for (const pair of parts.slice(1)) {
        const at = pair.indexOf('=');
        if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
      }

      const existing = (await commands.personas()).personas.find((entry) => entry.id === id);
      const avatar = fields.get('avatar') ?? existing?.avatar_url ?? null;
      if (avatar !== null && !MXC_URI.test(avatar)) return usageError('addpmp');

      await commands.savePersona(
        {
          id,
          display_name: fields.get('name') ?? existing?.display_name ?? id,
          avatar_url: avatar,
          pronouns: existing?.pronouns ?? [],
          color_on_light: existing?.color_on_light ?? null,
          color_on_dark: existing?.color_on_dark ?? null,
          triggers: existing?.triggers ?? [],
          pluralkit: existing?.pluralkit ?? null,
        },
        existing ? id : null
      );
      return { kind: 'done' };
    },
  },
  {
    name: 'delpmp',
    run: async (args, { commands }) => {
      const id = args.trim();
      if (id === '' || id === 'index') return usageError('delpmp');

      await commands.removePersona(id);
      return { kind: 'done' };
    },
  },
  {
    name: 'usepmp',
    run: async (args, { roomId, commands }) => {
      const parts = words(args);
      if (parts.length === 0 || parts.length > 2) return usageError('usepmp');

      const id = parts[0];
      if (id === 'reset') {
        await commands.setPersonaSelection(roomId, null);
        return { kind: 'done' };
      }

      const validUntil = parts.length === 2 ? Number(parts[1]) : null;
      if (validUntil !== null && !Number.isFinite(validUntil)) return usageError('usepmp');

      await commands.setPersonaSelection(roomId, id, validUntil);
      return { kind: 'done' };
    },
  },
];

function plainTextFrom(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .trim();
}

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
      return { kind: 'message', body: parsed.body, msgtype: 'text', formatted: null };
    case 'unknown':
      throw new SlashError('composer.slashUnknown', { name: parsed.name });
    case 'command': {
      const outcome = await parsed.command.run(parsed.args, context);
      if (outcome.kind === 'error') throw new SlashError(outcome.key, outcome.values);
      return outcome;
    }
  }
}
