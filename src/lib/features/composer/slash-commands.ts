import type { MemberView, MessageKind, SlashInvocation } from '#src/generated/protocol';
import { CoreError } from '#src/transport';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { parseSlash } from '#lib/model/model.js';
import { currentFix } from '#lib/platform/geolocation.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { geoUriFor } from './composer-location.js';
import { rainbowFormatted, rainbowHtml } from './rainbow.js';

export { parseSlash, pronounSets, slashCommandNames } from '#lib/model/model.js';

export type SlashCommandApi = Pick<
  CoreCommands,
  | 'accountData'
  | 'addRoomWidget'
  | 'banUser'
  | 'bulkRedact'
  | 'createDm'
  | 'disableRoomPersonas'
  | 'discardRoomKey'
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
  | 'setMemberLook'
  | 'setPronouns'
  | 'setAccountData'
  | 'sendGesture'
  | 'sendLocation'
  | 'sendStateEvent'
  | 'setDirect'
  | 'setDisplayName'
  | 'setPersonaSelection'
  | 'setRoomName'
  | 'setRoomTopic'
  | 'unbanUser'
  | 'unignoreUser'
  | 'updateServerAcl'
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

function localeKey(name: string, part: 'description' | 'usage'): string {
  return `composer.slash.${name}.${part}`;
}

export function descriptionKey(name: string): string {
  return localeKey(name, 'description');
}

export function usageKey(name: string): string {
  return localeKey(name, 'usage');
}

export const COSMETIC_EVENT_TYPES = {
  color: 'moe.sable.room.cosmetics.color',
  pronoun: 'moe.sable.room.cosmetics.pronouns',
} as const;

const MXC_URI = /^mxc:\/\/\S+$/;

function message(
  body: string,
  msgtype: MessageKind,
  formatted: string | null = null
): SlashOutcome {
  return { kind: 'message', body, msgtype, formatted };
}

function usageError(name: string): SlashOutcome {
  return { kind: 'error', key: usageKey(name) };
}

const DONE: SlashOutcome = { kind: 'done' };

async function resolveTargets(
  tokens: readonly string[],
  roomId: string,
  commands: SlashCommandApi,
  excludeBanned: boolean
): Promise<{ userIds: string[] } | SlashOutcome> {
  const userIds = new Set<string>();
  let members: MemberView[] | null = null;

  for (const token of tokens) {
    if (!token.startsWith('@*:')) {
      userIds.add(token);
      continue;
    }

    const server = token.slice('@*:'.length);
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

type ModerationVerb = Extract<keyof SlashCommandApi, 'banUser' | 'kickUser'>;

async function moderate(
  name: string,
  invocation: { targets: string[]; reason: string | null },
  verb: ModerationVerb,
  excludeBanned: boolean,
  { roomId, commands }: SlashContext
): Promise<SlashOutcome> {
  const resolved = await resolveTargets(invocation.targets, roomId, commands, excludeBanned);
  if (!('userIds' in resolved)) return resolved;
  if (resolved.userIds.length === 0) return usageError(name);

  for (const userId of resolved.userIds) await commands[verb](roomId, userId, invocation.reason);
  return DONE;
}

async function eachUser(
  userIds: readonly string[],
  act: (userId: string) => Promise<unknown>
): Promise<SlashOutcome> {
  for (const userId of userIds) await act(userId);
  return DONE;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function sendLocation(
  name: string,
  latitude: number,
  longitude: number,
  { roomId, commands }: SlashContext
): Promise<SlashOutcome> {
  const geoUri = geoUriFor(latitude, longitude);
  if (geoUri === null) return usageError(name);

  await commands.sendLocation(roomId, geoUri.slice('geo:'.length), geoUri);
  return DONE;
}

async function shareMyLocation(context: SlashContext): Promise<SlashOutcome> {
  const result = await currentFix();
  if (result.kind !== 'fix') return { kind: 'error', key: `composer.slashFix.${result.kind}` };

  const geoUri = geoUriFor(result.fix.latitude, result.fix.longitude);
  if (geoUri === null) return { kind: 'error', key: 'composer.slashFix.unavailable' };

  await context.commands.sendLocation(context.roomId, geoUri.slice('geo:'.length), geoUri);
  return DONE;
}

async function addWidget(
  name: string,
  widget: { url: string; name: string },
  { roomId, userId, commands }: SlashContext
): Promise<SlashOutcome> {
  if (userId === null) return usageError(name);
  try {
    await commands.addRoomWidget(roomId, widget.name, widget.url);
  } catch (error) {
    if (error instanceof CoreError && error.detail.code === 'invalid_url') {
      return usageError(name);
    }
    throw error;
  }
  return DONE;
}

async function addPersona(
  name: string,
  persona: { id: string; name: string | null; avatar: string | null },
  { commands }: SlashContext
): Promise<SlashOutcome> {
  const { id } = persona;
  const existing = (await commands.personas()).personas.find((entry) => entry.id === id);
  const avatar = persona.avatar ?? existing?.avatar_url ?? null;
  if (avatar !== null && !MXC_URI.test(avatar)) return usageError(name);

  await commands.savePersona(
    {
      id,
      display_name: persona.name ?? existing?.display_name ?? id,
      avatar_url: avatar,
      pronouns: existing?.pronouns ?? [],
      color_on_light: existing?.color_on_light ?? null,
      color_on_dark: existing?.color_on_dark ?? null,
      triggers: existing?.triggers ?? [],
      pluralkit: existing?.pluralkit ?? null,
      last_used: existing?.last_used ?? null,
    },
    existing ? id : null
  );
  return DONE;
}

async function addPersonaProxy(
  name: string,
  proxy: { id: string; prefix: string | null; suffix: string | null },
  { commands }: SlashContext
): Promise<SlashOutcome> {
  const persona = (await commands.personas()).personas.find((entry) => entry.id === proxy.id);
  if (persona === undefined) return usageError(name);

  await commands.savePersona(
    {
      ...persona,
      triggers: [
        ...persona.triggers,
        { prefix: proxy.prefix, suffix: proxy.suffix, keep_trigger: false },
      ],
    },
    proxy.id
  );
  return DONE;
}

async function deleteAccountDataKey(
  name: string,
  { event_type: eventType, key }: { event_type: string; key: string },
  { commands }: SlashContext
): Promise<SlashOutcome> {
  const content = objectValue(await commands.accountData(eventType));
  if (!(key in content)) return usageError(name);

  const updated = { ...content };
  Reflect.deleteProperty(updated, key);
  await commands.setAccountData(eventType, updated);
  return DONE;
}

async function bulkRedact(
  name: string,
  redaction: Extract<SlashInvocation, { command: 'bulk_redact' }>,
  { roomId, commands }: SlashContext
): Promise<SlashOutcome> {
  const resolved = await resolveTargets(redaction.targets, roomId, commands, false);
  if (!('userIds' in resolved)) return resolved;
  if (resolved.userIds.length === 0) return usageError(name);

  await commands.bulkRedact(
    roomId,
    resolved.userIds,
    redaction.after_ts,
    redaction.event_types,
    redaction.reason
  );
  return DONE;
}

async function run(
  name: string,
  invocation: SlashInvocation,
  context: SlashContext
): Promise<SlashOutcome> {
  const { roomId, userId, commands } = context;
  switch (invocation.command) {
    case 'bug_report':
      return { kind: 'bugReport' };
    case 'gif_search':
      return { kind: 'gifSearch', query: invocation.query };
    case 'gesture':
      await commands.sendGesture(roomId, invocation.gesture, invocation.target);
      return DONE;
    case 'message': {
      const { body, msgtype, formatted } = invocation;
      return invocation.verbatim
        ? { kind: 'message', body, msgtype, formatted, verbatim: true }
        : message(body, msgtype, formatted);
    }
    case 'rainbow': {
      const { body, msgtype, formatted } = invocation;
      return message(
        body,
        msgtype,
        formatted === null ? rainbowHtml(body) : rainbowFormatted(formatted)
      );
    }
    case 'html':
      return message(plainTextFrom(invocation.html), 'text', invocation.html);
    case 'join':
      await commands.joinRoom(invocation.address, invocation.via);
      return DONE;
    case 'knock':
      await commands.knockRoom(invocation.address, invocation.via, invocation.reason ?? undefined);
      return DONE;
    case 'leave':
      await commands.leaveRoom(roomId);
      return DONE;
    case 'invite':
      await commands.inviteUser(roomId, invocation.user_id);
      return DONE;
    case 'kick':
      return moderate(name, invocation, 'kickUser', true, context);
    case 'ban':
      return moderate(name, invocation, 'banUser', false, context);
    case 'unban':
      await commands.unbanUser(roomId, invocation.user_id, invocation.reason);
      return DONE;
    case 'display_name':
      await commands.setDisplayName(invocation.name, preferences.profileChangePropagation);
      return DONE;
    case 'member_look':
      if (userId === null) return usageError(name);
      await commands.setMemberLook(roomId, invocation.look, invocation.in_parent_space);
      return DONE;
    case 'pronouns':
      if (userId === null) return usageError(name);
      await commands.setPronouns(roomId, invocation.pronouns, invocation.in_parent_space);
      return DONE;
    case 'room_name':
      await commands.setRoomName(roomId, invocation.name);
      return DONE;
    case 'topic':
      await commands.setRoomTopic(roomId, invocation.topic);
      return DONE;
    case 'disinvite':
      return eachUser(invocation.user_ids, (target) => commands.kickUser(roomId, target));
    case 'ignore':
      return eachUser(invocation.user_ids, (target) => commands.ignoreUser(target));
    case 'unignore':
      return eachUser(invocation.user_ids, (target) => commands.unignoreUser(target));
    case 'start_dm':
      return eachUser(invocation.user_ids, (target) => commands.createDm(target));
    case 'convert_to_dm':
      await commands.setDirect(roomId, true, invocation.user_id ?? undefined);
      return DONE;
    case 'convert_to_room':
      await commands.setDirect(roomId, false);
      return DONE;
    case 'discard_session':
      await commands.discardRoomKey(roomId);
      return DONE;
    case 'acl':
      await commands.updateServerAcl(roomId, {
        allow: invocation.allow,
        deny: invocation.deny,
        removeAllow: invocation.remove_allow,
        removeDeny: invocation.remove_deny,
      });
      return DONE;
    case 'add_widget':
      return addWidget(name, invocation, context);
    case 'location':
      return sendLocation(name, invocation.latitude, invocation.longitude, context);
    case 'share_my_location':
      return shareMyLocation(context);
    case 'add_persona':
      return addPersona(name, invocation, context);
    case 'remove_persona':
      await commands.removePersona(invocation.id);
      return DONE;
    case 'use_persona':
      await commands.setPersonaSelection(roomId, invocation.id, invocation.valid_until);
      return DONE;
    case 'reset_persona':
      await commands.setPersonaSelection(roomId, null);
      return DONE;
    case 'disable_room_personas':
      await commands.disableRoomPersonas(roomId);
      return DONE;
    case 'persona_proxy':
      return addPersonaProxy(name, invocation, context);
    case 'raw_message':
      await commands.sendRawEvent(roomId, 'm.room.message', invocation.content);
      return DONE;
    case 'raw_event':
      if (invocation.state_key === null) {
        await commands.sendRawEvent(roomId, invocation.event_type, invocation.content);
      } else {
        await commands.sendStateEvent(
          roomId,
          invocation.event_type,
          invocation.state_key,
          invocation.content
        );
      }
      return DONE;
    case 'raw_account_data': {
      const existing = objectValue(await commands.accountData(invocation.event_type));
      await commands.setAccountData(invocation.event_type, {
        ...existing,
        ...invocation.content,
      });
      return DONE;
    }
    case 'delete_account_data_key':
      return deleteAccountDataKey(name, invocation, context);
    case 'bulk_redact':
      return bulkRedact(name, invocation, context);
  }
}

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

export async function runSlash(body: string, context: SlashContext): Promise<SlashResult> {
  const parsed = parseSlash(body, context.formatted ?? null);

  switch (parsed.kind) {
    case 'none':
      return { kind: 'message', body, msgtype: 'text' };
    case 'literal':
      return { kind: 'message', body: parsed.body, msgtype: 'text', formatted: null };
    case 'unknown':
      throw new SlashError('composer.slashUnknown', { name: parsed.name });
    case 'usage':
    case 'command': {
      if (parsed.developer_only && context.developerTools !== true) {
        throw new SlashError('composer.slashDeveloperOnly');
      }
      if (parsed.kind === 'usage') throw new SlashError(usageKey(parsed.name));
      const outcome = await run(parsed.name, parsed.invocation, context);
      if (outcome.kind === 'error') throw new SlashError(outcome.key, outcome.values);
      return outcome;
    }
  }
}
