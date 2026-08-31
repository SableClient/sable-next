import type { MemberView } from '#src/generated/MemberView';
import type { MessageKind } from '#src/generated/MessageKind';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { parseJoinAddress } from '#lib/features/room/join-address.js';
import { currentFix } from '#lib/platform/geolocation.js';

import { coordinate, geoUriFor } from './composer-location.js';
import { escapeHtml, rainbowHtml } from './rainbow.js';

export type SlashCommandApi = Pick<
  CoreCommands,
  | 'accountData'
  | 'banUser'
  | 'bulkRedact'
  | 'createDm'
  | 'ignoreUser'
  | 'inviteUser'
  | 'joinRoom'
  | 'kickUser'
  | 'knockRoom'
  | 'leaveRoom'
  | 'personas'
  | 'removePersona'
  | 'roomMembers'
  | 'roomStateEvent'
  | 'sendRawEvent'
  | 'savePersona'
  | 'setAccountData'
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
  formatted?: string | null;
  developerTools?: boolean;
  commands: SlashCommandApi;
};

export type SlashOutcome =
  | {
      kind: 'message';
      body: string;
      msgtype: MessageKind;
      formatted?: string | null;
      verbatim?: boolean;
    }
  | { kind: 'gifSearch'; query: string }
  | { kind: 'bugReport' }
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

const SLASH_PREFIX = /^\s*\/([a-z0-9]+)(\s+|$)/i;

function withoutPrefix(name: string, formatted: string | null | undefined): string | null {
  if (!formatted) return null;
  const match = SLASH_PREFIX.exec(formatted);
  return match && match[1].toLowerCase() === name ? formatted.slice(match[0].length) : null;
}

function verbatim(body: string, msgtype: MessageKind, formatted: string | null): SlashOutcome {
  return { kind: 'message', body, msgtype, formatted, verbatim: true };
}

function usageError(name: string): SlashOutcome {
  return { kind: 'error', key: localeKey(name, 'usage') };
}

function speech(name: string, msgtype: MessageKind): SlashCommand {
  return {
    name,
    run: (args, { formatted }) => {
      const text = args.trim();
      return text === ''
        ? usageError(name)
        : verbatim(text, msgtype, withoutPrefix(name, formatted));
    },
  };
}

function decorated(name: string, suffix: string): SlashCommand {
  return {
    name,
    run: (args, { formatted }) => {
      const text = args.trim();
      if (text === '') return message(suffix, 'text');

      const html = withoutPrefix(name, formatted);
      return verbatim(
        `${text} ${suffix}`,
        'text',
        html === null ? null : `${html} ${escapeHtml(suffix)}`
      );
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

const SERVER_WILDCARD = /^@\*:(\S+)$/;

function isTargetToken(token: string): boolean {
  return USER_ID.test(token) || SERVER_WILDCARD.test(token);
}

function targetTokens(args: string): { tokens: string[]; reason: string | null } | null {
  const all = words(args);
  let end = 0;
  while (end < all.length && isTargetToken(all[end])) end += 1;
  if (end === 0) return null;

  const reason = all.slice(end).join(' ').trim();
  return { tokens: all.slice(0, end), reason: reason === '' ? null : reason };
}

async function resolveTargets(
  tokens: readonly string[],
  roomId: string,
  commands: SlashCommandApi,
  excludeBanned: boolean
): Promise<{ userIds: string[] } | SlashOutcome> {
  const userIds = new Set<string>();
  let members: MemberView[] | null = null;

  for (const token of tokens) {
    const wildcard = SERVER_WILDCARD.exec(token);
    if (wildcard === null) {
      userIds.add(token);
      continue;
    }

    const server = wildcard[1];
    members ??= await commands.roomMembers(roomId);
    const matches = members
      .filter((member) => member.user_id.endsWith(`:${server}`))
      .filter((member) => !excludeBanned || member.membership !== 'ban');
    if (matches.length === 0) {
      return { kind: 'error', key: 'composer.slashWildcardEmpty', values: { server } };
    }
    for (const match of matches) userIds.add(match.user_id);
  }

  return { userIds: [...userIds] };
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

function moderationTargets(
  name: string,
  verb: ModerationVerb,
  excludeBanned: boolean
): SlashCommand {
  return {
    name,
    run: async (args, { roomId, commands }) => {
      const parsed = targetTokens(args);
      if (parsed === null) return usageError(name);

      const resolved = await resolveTargets(parsed.tokens, roomId, commands, excludeBanned);
      if (!('userIds' in resolved)) return resolved;
      if (resolved.userIds.length === 0) return usageError(name);

      for (const userId of resolved.userIds) await commands[verb](roomId, userId, parsed.reason);
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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PRONOUN_ENTRY = /^([a-z]{2}):(.+)$/;

function isReset(text: string): boolean {
  return text === '' || text.toLowerCase() === 'reset' || text.toLowerCase() === 'clear';
}

function colorContent(text: string): Record<string, unknown> | null {
  if (isReset(text)) return {};
  return HEX_COLOR.test(text) ? { on_dark: text, on_light: text } : null;
}

function fontContent(text: string): Record<string, unknown> | null {
  if (isReset(text)) return {};
  const font = text.replaceAll(/[;{}<>]/g, '').slice(0, 32);
  return font === '' ? null : { font };
}

function pronounContent(text: string): Record<string, unknown> | null {
  if (isReset(text)) return {};
  const pronouns = text.split(',').map((entry) => {
    const trimmed = entry.trim();
    const match = PRONOUN_ENTRY.exec(trimmed);
    return match ? { language: match[1], summary: match[2].trim() } : { summary: trimmed };
  });
  return { pronouns };
}

const COSMETIC_EVENT_TYPES = {
  color: 'moe.sable.room.cosmetics.color',
  font: 'moe.sable.room.cosmetics.font',
  pronoun: 'moe.sable.room.cosmetics.pronouns',
} as const;

function ownCosmetic(
  name: keyof typeof COSMETIC_EVENT_TYPES,
  build: (text: string) => Record<string, unknown> | null
): SlashCommand {
  return {
    name,
    run: async (args, { roomId, userId, commands }) => {
      if (userId === null) return usageError(name);

      const content = build(args.trim());
      if (content === null) return usageError(name);

      await commands.sendStateEvent(roomId, COSMETIC_EVENT_TYPES[name], userId, content);
      return { kind: 'done' };
    },
  };
}

function otherCosmetic(
  name: string,
  eventType: string,
  build: (text: string) => Record<string, unknown> | null
): SlashCommand {
  return {
    name,
    run: async (args, { roomId, commands }) => {
      const [first, ...rest] = args.trim().split(/\s+/);
      if (!USER_ID.test(first)) return usageError(name);

      const content = build(rest.join(' ').trim());
      if (content === null) return usageError(name);

      await commands.sendStateEvent(roomId, eventType, first, content);
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

function flagValues(args: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  let flag: string | null = null;
  for (const token of words(args)) {
    if (token.startsWith('-') && token.length > 1) {
      flag = token.slice(1);
      values.set(flag, []);
    } else if (flag !== null) {
      values.get(flag)?.push(token);
    }
  }
  return values;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function developerOnly(context: SlashContext): SlashOutcome | null {
  return context.developerTools === true
    ? null
    : { kind: 'error', key: 'composer.slashDeveloperOnly' };
}

function jsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rawEventArgs(
  args: string
): { eventType: string; content: Record<string, unknown>; stateKey: string | null } | null {
  const trimmed = args.trim();
  const stateFlag = trimmed.match(/\s+-s\s+(\S+)\s*$/);
  const payload = stateFlag ? trimmed.slice(0, stateFlag.index).trimEnd() : trimmed;
  const split = payload.search(/\s/);
  if (split < 1) return null;

  const content = jsonObject(payload.slice(split + 1).trim());
  if (content === null) return null;

  return {
    eventType: payload.slice(0, split),
    content,
    stateKey: stateFlag?.[1] ?? null,
  };
}

function deleteArgs(args: string): {
  senderTokens: string[];
  afterTs: number;
  eventTypes: string[];
  reason: string | null;
} | null {
  const match = args.match(/\s-(?=\w)/);
  const targets = match ? args.slice(0, match.index).trim() : args.trim();
  const flags = match ? flagValues(args.slice(match.index)) : new Map<string, string[]>();
  const past = flags.get('past')?.[0];
  const pastMatch = past?.match(/^(\d+(?:\.\d+)?)([dhms])$/);
  if (!pastMatch) return null;

  const value = Number(pastMatch[1]);
  const units = { d: 24 * 60 * 60 * 1000, h: 60 * 60 * 1000, m: 60 * 1000, s: 1000 };
  const afterTs = Date.now() - value * units[pastMatch[2] as keyof typeof units];
  const senderTokens = words(targets).filter(isTargetToken);
  if (senderTokens.length === 0 || !Number.isSafeInteger(afterTs)) return null;

  return {
    senderTokens,
    afterTs,
    eventTypes: flags.get('t') ?? [],
    reason: flags.get('r')?.join(' ') || null,
  };
}

function cute(name: string, cuteType: string, body: string): SlashCommand {
  return {
    name,
    run: async (args, { roomId, commands }) => {
      const target = args.trim();
      if (target !== '' && !USER_ID.test(target)) return usageError(name);

      await commands.sendRawEvent(roomId, 'm.room.message', {
        msgtype: 'im.fluffychat.cute_event',
        'm.mentions': { user_ids: target === '' ? [] : [target] },
        cute_type: cuteType,
        body,
      });
      return { kind: 'done' };
    },
  };
}

function headpat(): SlashCommand {
  return {
    name: 'headpat',
    run: async (args, { roomId, commands }) => {
      const target = args.trim();
      if (target !== '' && !USER_ID.test(target)) return usageError('headpat');

      await commands.sendRawEvent(roomId, 'm.room.message', {
        msgtype: 'm.emote',
        'm.mentions': { user_ids: target === '' ? [] : [target] },
        body: `pats ${target || 'you'}`,
        'fyi.cisnt.headpat': true,
      });
      return { kind: 'done' };
    },
  };
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'bugreport',
    run: (args) => (args.trim() === '' ? { kind: 'bugReport' } : usageError('bugreport')),
  },
  {
    name: 'gif',
    run: (args) => ({ kind: 'gifSearch', query: args.trim() }),
  },
  cute('hug', 'hug', '🤗'),
  cute('cuddle', 'cuddle', '😊'),
  cute('wave', 'wave', '👋'),
  cute('poke', 'poke', '🫵'),
  headpat(),
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
  moderationTargets('kick', 'kickUser', true),
  moderationTargets('ban', 'banUser', false),
  moderation('unban', 'unbanUser'),
  setter('nick', (text, { commands }) => commands.setDisplayName(text)),
  ownCosmetic('color', colorContent),
  otherCosmetic('scolor', COSMETIC_EVENT_TYPES.color, colorContent),
  ownCosmetic('font', fontContent),
  otherCosmetic('sfont', COSMETIC_EVENT_TYPES.font, fontContent),
  ownCosmetic('pronoun', pronounContent),
  otherCosmetic('spronoun', COSMETIC_EVENT_TYPES.pronoun, pronounContent),
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
    name: 'acl',
    run: async (args, { roomId, commands }) => {
      const flags = flagValues(args);
      const allow = flags.get('a') ?? [];
      const deny = flags.get('d') ?? [];
      const removeAllow = new Set(flags.get('ra') ?? []);
      const removeDeny = new Set(flags.get('rd') ?? []);
      if (
        allow.length === 0 &&
        deny.length === 0 &&
        removeAllow.size === 0 &&
        removeDeny.size === 0
      ) {
        return usageError('acl');
      }

      const current = objectValue(await commands.roomStateEvent(roomId, 'm.room.server_acl'));
      const currentAllow = Array.isArray(current.allow)
        ? current.allow.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const currentDeny = Array.isArray(current.deny)
        ? current.deny.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const content = {
        ...current,
        allow: [...new Set([...currentAllow, ...allow])].filter((entry) => !removeAllow.has(entry)),
        deny: [...new Set([...currentDeny, ...deny])].filter((entry) => !removeDeny.has(entry)),
      };
      await commands.sendStateEvent(roomId, 'm.room.server_acl', '', content);
      return { kind: 'done' };
    },
  },
  {
    name: 'addwidget',
    run: async (args, { roomId, userId, commands }) => {
      const parts = words(args);
      if (parts.length === 0 || userId === null) return usageError('addwidget');
      const [rawUrl, ...nameParts] = parts;

      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return usageError('addwidget');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return usageError('addwidget');

      const name = nameParts.join(' ') || 'Widget';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      await commands.sendStateEvent(roomId, 'im.vector.modular.widgets', id, {
        type: 'm.custom',
        url: url.toString(),
        name,
        id,
        creatorUserId: userId,
      });
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
  {
    name: 'pmpproxy',
    run: async (args, { commands }) => {
      const parts = words(args);
      if (parts.length !== 2) return usageError('pmpproxy');
      const id = parts[0];
      const proxy = parts[1];
      const marker = proxy.indexOf('text');
      if (marker < 0) return usageError('pmpproxy');

      const persona = (await commands.personas()).personas.find((entry) => entry.id === id);
      if (persona === undefined) return usageError('pmpproxy');

      await commands.savePersona(
        {
          ...persona,
          triggers: [
            ...persona.triggers,
            {
              prefix: proxy.slice(0, marker) || null,
              suffix: proxy.slice(marker + 'text'.length) || null,
              keep_trigger: false,
            },
          ],
        },
        id
      );
      return { kind: 'done' };
    },
  },
  {
    name: 'rawmsg',
    run: async (args, context) => {
      const denied = developerOnly(context);
      if (denied) return denied;

      const content = jsonObject(args.trim());
      if (content === null) return usageError('rawmsg');

      await context.commands.sendRawEvent(context.roomId, 'm.room.message', content);
      return { kind: 'done' };
    },
  },
  {
    name: 'raw',
    run: async (args, context) => {
      const denied = developerOnly(context);
      if (denied) return denied;

      const parsed = rawEventArgs(args);
      if (parsed === null) return usageError('raw');

      if (parsed.stateKey === null) {
        await context.commands.sendRawEvent(context.roomId, parsed.eventType, parsed.content);
      } else {
        await context.commands.sendStateEvent(
          context.roomId,
          parsed.eventType,
          parsed.stateKey,
          parsed.content
        );
      }
      return { kind: 'done' };
    },
  },
  {
    name: 'rawacc',
    run: async (args, context) => {
      const denied = developerOnly(context);
      if (denied) return denied;

      const split = args.trim().search(/\s/);
      if (split < 1) return usageError('rawacc');

      const eventType = args.trim().slice(0, split);
      const content = jsonObject(
        args
          .trim()
          .slice(split + 1)
          .trim()
      );
      if (content === null) return usageError('rawacc');

      const existing = objectValue(await context.commands.accountData(eventType));
      await context.commands.setAccountData(eventType, { ...existing, ...content });
      return { kind: 'done' };
    },
  },
  {
    name: 'delacc',
    run: async (args, context) => {
      const denied = developerOnly(context);
      if (denied) return denied;

      const parts = words(args);
      if (parts.length !== 2) return usageError('delacc');

      const [eventType, key] = parts;
      const content = objectValue(await context.commands.accountData(eventType));
      if (!(key in content)) return usageError('delacc');

      const updated = { ...content };
      Reflect.deleteProperty(updated, key);
      await context.commands.setAccountData(eventType, updated);
      return { kind: 'done' };
    },
  },
  {
    name: 'delete',
    run: async (args, context) => {
      const parsed = deleteArgs(args);
      if (parsed === null) return usageError('delete');

      const resolved = await resolveTargets(
        parsed.senderTokens,
        context.roomId,
        context.commands,
        false
      );
      if (!('userIds' in resolved)) return resolved;
      if (resolved.userIds.length === 0) return usageError('delete');

      await context.commands.bulkRedact(
        context.roomId,
        resolved.userIds,
        parsed.afterTs,
        parsed.eventTypes,
        parsed.reason
      );
      return { kind: 'done' };
    },
  },
];

function textFrom(node: Node): string {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === child.TEXT_NODE) {
      text += child.nodeValue ?? '';
      continue;
    }
    if (child.nodeType !== child.ELEMENT_NODE) continue;

    const element = child as Element;
    switch (element.tagName.toLowerCase()) {
      case 'br':
        text += '\n';
        break;
      case 'li':
        text += `\n- ${textFrom(element)}`;
        break;
      case 'a': {
        const href = element.getAttribute('href');
        const label = textFrom(element);
        text += href === null || href === '' ? label : `${label} (${href})`;
        break;
      }
      default:
        text += textFrom(element);
    }
  }
  return text;
}

function plainTextFrom(html: string): string {
  return textFrom(new DOMParser().parseFromString(html, 'text/html').body).trim();
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
