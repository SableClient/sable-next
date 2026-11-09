import type {
  MemberView,
  MessageKind,
  PerMessageProfileView,
  PersonaView,
  SlashInvocation,
  Rpc,
} from '#src/generated/protocol';
import { CoreError } from '#src/transport';

import { knockRoom, openDirectMessage } from '#lib/core/api/rooms.js';
import type { E2eePolicy } from '#lib/deployment/e2ee-policy.js';
import { setMemberLook } from '#lib/core/api/members.js';
import { joinOrOfferKnock } from '#lib/rooms/join-or-knock.js';
import { parseSlash } from '#lib/model/model.js';
import { currentFix } from '#lib/platform/geolocation.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { geoUriFor } from './composer-location.js';
import { rainbowFormatted, rainbowHtml } from './rainbow.js';
import { isRecord } from '#lib/guards.js';

export { parseSlash, pronounSets, slashCommandNames } from '#lib/model/model.js';

export type SlashAccountApi = Pick<
  Rpc['account'],
  'data' | 'ignoreUser' | 'setData' | 'setDirect' | 'setDisplayName' | 'unignoreUser'
>;

export type SlashRpc = {
  members: Rpc['members'];
  rooms: Rpc['rooms'];
  account: SlashAccountApi;
  encryption: Pick<Rpc['encryption'], 'discardRoomKey' | 'shareHistory'>;
  messages: Pick<Rpc['messages'], 'bulkRedact' | 'sendGesture' | 'sendLocation' | 'sendRawEvent'>;
  room_state: Pick<
    Rpc['room_state'],
    'addWidget' | 'sendEvent' | 'setName' | 'setTopic' | 'updateServerAcl'
  >;
  personas: Pick<Rpc['personas'], 'disableRoom' | 'list' | 'remove' | 'save' | 'setSelection'>;
};

export type SlashContext = {
  roomId: string;
  userId: string | null;
  formatted?: string | null;
  developerTools?: boolean;
  rpc: SlashRpc;
  e2eePolicy: () => Promise<E2eePolicy>;
  persona?: () => PerMessageProfileView | null;
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
  | { kind: 'knock'; address: string; via: string[] }
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
  rpc: SlashContext['rpc'],
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
    members ??= await rpc.members.list({ room_id: roomId, memberships: [] });
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

type ModerationVerb = 'ban' | 'kick';

async function moderate(
  name: string,
  invocation: { targets: string[]; reason: string | null },
  verb: ModerationVerb,
  excludeBanned: boolean,
  { roomId, rpc }: SlashContext
): Promise<SlashOutcome> {
  const resolved = await resolveTargets(invocation.targets, roomId, rpc, excludeBanned);
  if (!('userIds' in resolved)) return resolved;
  if (resolved.userIds.length === 0) return usageError(name);

  for (const userId of resolved.userIds) {
    await rpc.members[verb]({ room_id: roomId, user_id: userId, reason: invocation.reason });
  }
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
  return isRecord(value) ? value : {};
}

function locationParams(roomId: string, geoUri: string) {
  return {
    room_id: roomId,
    body: geoUri.slice('geo:'.length),
    geo_uri: geoUri,
    in_reply_to: null,
    silent_reply: false,
    thread_root: null,
  };
}

async function sendLocation(
  name: string,
  latitude: number,
  longitude: number,
  { roomId, rpc, persona }: SlashContext
): Promise<SlashOutcome> {
  const geoUri = geoUriFor(latitude, longitude);
  if (geoUri === null) return usageError(name);

  await rpc.messages.sendLocation({
    ...locationParams(roomId, geoUri),
    ...(persona ? { persona: persona() } : {}),
  });
  return DONE;
}

async function shareMyLocation(context: SlashContext): Promise<SlashOutcome> {
  const result = await currentFix();
  if (result.kind !== 'fix') return { kind: 'error', key: `composer.slashFix.${result.kind}` };

  const geoUri = geoUriFor(result.fix.latitude, result.fix.longitude);
  if (geoUri === null) return { kind: 'error', key: 'composer.slashFix.unavailable' };

  await context.rpc.messages.sendLocation({
    ...locationParams(context.roomId, geoUri),
    ...(context.persona ? { persona: context.persona() } : {}),
  });
  return DONE;
}

async function addWidget(
  name: string,
  widget: { url: string; name: string },
  { roomId, userId, rpc }: SlashContext
): Promise<SlashOutcome> {
  if (userId === null) return usageError(name);
  try {
    await rpc.room_state.addWidget({ room_id: roomId, name: widget.name, url: widget.url });
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
  { rpc }: SlashContext
): Promise<SlashOutcome> {
  const { id } = persona;
  const existing = (await rpc.personas.list()).personas.find((entry) => entry.id === id);
  const avatar = persona.avatar ?? existing?.avatar_url ?? null;
  if (avatar !== null && !MXC_URI.test(avatar)) return usageError(name);

  const next = {
    id,
    display_name: persona.name ?? existing?.display_name ?? id,
    avatar_url: avatar,
    pronouns: existing?.pronouns ?? [],
    color_on_light: existing?.color_on_light ?? null,
    color_on_dark: existing?.color_on_dark ?? null,
    triggers: existing?.triggers ?? [],
    pluralkit: existing?.pluralkit ?? null,
    last_used: existing?.last_used ?? null,
    alternate_avatars: existing?.alternate_avatars ?? null,
    biography: existing?.biography ?? null,
    banner_url: existing?.banner_url ?? null,
    is_animal: existing?.is_animal ?? null,
    has_animal: existing?.has_animal ?? null,
    animal_need: existing?.animal_need ?? null,
    sort_flags: existing?.sort_flags ?? null,
  } satisfies PersonaView;
  await rpc.personas.save({
    persona: next,
    base_persona: existing ?? next,
    previous_id: existing ? id : null,
  });
  return DONE;
}

async function addPersonaProxy(
  name: string,
  proxy: { id: string; prefix: string | null; suffix: string | null },
  { rpc }: SlashContext
): Promise<SlashOutcome> {
  const persona = (await rpc.personas.list()).personas.find((entry) => entry.id === proxy.id);
  if (persona === undefined) return usageError(name);

  await rpc.personas.save({
    persona: {
      ...persona,
      triggers: [
        ...persona.triggers,
        {
          prefix: proxy.prefix,
          suffix: proxy.suffix,
          keep_trigger: false,
          alternate_avatar_id: null,
        },
      ],
    },
    base_persona: persona,
    previous_id: proxy.id,
  });
  return DONE;
}

async function deleteAccountDataKey(
  name: string,
  { event_type: eventType, key }: { event_type: string; key: string },
  { rpc }: SlashContext
): Promise<SlashOutcome> {
  const content = objectValue(await rpc.account.data({ event_type: eventType }));
  if (!(key in content)) return usageError(name);

  const updated = { ...content };
  Reflect.deleteProperty(updated, key);
  await rpc.account.setData({ event_type: eventType, content: updated });
  return DONE;
}

async function bulkRedact(
  name: string,
  redaction: Extract<SlashInvocation, { command: 'bulk_redact' }>,
  { roomId, rpc }: SlashContext
): Promise<SlashOutcome> {
  const resolved = await resolveTargets(redaction.targets, roomId, rpc, false);
  if (!('userIds' in resolved)) return resolved;
  if (resolved.userIds.length === 0) return usageError(name);

  await rpc.messages.bulkRedact({
    room_id: roomId,
    senders: [...resolved.userIds],
    after_ts: redaction.after_ts,
    event_types: [...redaction.event_types],
    reason: redaction.reason,
  });
  return DONE;
}

async function run(
  name: string,
  invocation: SlashInvocation,
  context: SlashContext
): Promise<SlashOutcome> {
  const { roomId, userId, rpc, e2eePolicy } = context;
  switch (invocation.command) {
    case 'bug_report':
      return { kind: 'bugReport' };
    case 'gif_search':
      return { kind: 'gifSearch', query: invocation.query };
    case 'gesture':
      await rpc.messages.sendGesture({
        room_id: roomId,
        gesture: invocation.gesture,
        target: invocation.target,
        ...(context.persona ? { persona: context.persona() } : {}),
      });
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
      return (await joinOrOfferKnock(rpc, invocation.address, invocation.via)).kind === 'knock'
        ? { kind: 'knock', address: invocation.address, via: invocation.via }
        : DONE;
    case 'knock':
      await knockRoom(rpc, invocation.address, invocation.via, invocation.reason ?? undefined);
      return DONE;
    case 'leave':
      await rpc.rooms.leave({ room_id: roomId });
      return DONE;
    case 'invite':
      await rpc.rooms.invite({ room_id: roomId, user_id: invocation.user_id });
      return DONE;
    case 'share_history': {
      const outcome = await rpc.encryption.shareHistory({
        room_id: roomId,
        user_id: invocation.user_id,
      });
      return outcome === 'shared'
        ? DONE
        : { kind: 'error', key: `composer.slashShareHistory.${outcome}` };
    }
    case 'kick':
      return moderate(name, invocation, 'kick', true, context);
    case 'ban':
      return moderate(name, invocation, 'ban', false, context);
    case 'unban':
      await rpc.members.unban({
        room_id: roomId,
        user_id: invocation.user_id,
        reason: invocation.reason,
      });
      return DONE;
    case 'display_name':
      await rpc.account.setDisplayName({
        name: invocation.name,
        propagate_to: preferences.profileChangePropagation,
      });
      return DONE;
    case 'member_look':
      if (userId === null) return usageError(name);
      await setMemberLook(rpc, roomId, invocation.look, invocation.in_parent_space);
      return DONE;
    case 'pronouns':
      if (userId === null) return usageError(name);
      await rpc.members.setPronouns({
        room_id: roomId,
        pronouns: invocation.pronouns,
        in_parent_space: invocation.in_parent_space,
      });
      return DONE;
    case 'room_name':
      await rpc.room_state.setName({ room_id: roomId, name: invocation.name });
      return DONE;
    case 'topic':
      await rpc.room_state.setTopic({ room_id: roomId, topic: invocation.topic });
      return DONE;
    case 'disinvite':
      return eachUser(invocation.user_ids, (target) =>
        rpc.members.kick({ room_id: roomId, user_id: target, reason: null })
      );
    case 'ignore':
      return eachUser(invocation.user_ids, (target) => rpc.account.ignoreUser({ user_id: target }));
    case 'unignore':
      return eachUser(invocation.user_ids, (target) =>
        rpc.account.unignoreUser({ user_id: target })
      );
    case 'start_dm':
      return eachUser(invocation.user_ids, (target) =>
        openDirectMessage({ rpc, e2eePolicy }, target)
      );
    case 'convert_to_dm':
      await rpc.account.setDirect({
        room_id: roomId,
        direct: true,
        user_id: invocation.user_id ?? null,
      });
      return DONE;
    case 'convert_to_room':
      await rpc.account.setDirect({ room_id: roomId, direct: false, user_id: null });
      return DONE;
    case 'discard_session':
      await rpc.encryption.discardRoomKey({ room_id: roomId });
      return DONE;
    case 'acl':
      await rpc.room_state.updateServerAcl({
        room_id: roomId,
        allow: invocation.allow,
        deny: invocation.deny,
        remove_allow: invocation.remove_allow,
        remove_deny: invocation.remove_deny,
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
      await rpc.personas.remove({ id: invocation.id });
      return DONE;
    case 'use_persona':
      await rpc.personas.setSelection({
        room_id: roomId,
        persona_id: invocation.id,
        valid_until: invocation.valid_until,
      });
      return DONE;
    case 'reset_persona':
      await rpc.personas.setSelection({
        room_id: roomId,
        persona_id: null,
        valid_until: null,
      });
      return DONE;
    case 'disable_room_personas':
      await rpc.personas.disableRoom({ room_id: roomId });
      return DONE;
    case 'persona_proxy':
      return addPersonaProxy(name, invocation, context);
    case 'raw_message':
      await rpc.messages.sendRawEvent({
        room_id: roomId,
        event_type: 'm.room.message',
        content: invocation.content,
        ...(context.persona ? { persona: context.persona() } : {}),
      });
      return DONE;
    case 'raw_event':
      if (invocation.state_key === null) {
        await rpc.messages.sendRawEvent({
          room_id: roomId,
          event_type: invocation.event_type,
          content: invocation.content,
          ...(context.persona ? { persona: context.persona() } : {}),
        });
      } else {
        await rpc.room_state.sendEvent({
          room_id: roomId,
          event_type: invocation.event_type,
          state_key: invocation.state_key,
          content: invocation.content,
        });
      }
      return DONE;
    case 'raw_account_data': {
      const existing = objectValue(await rpc.account.data({ event_type: invocation.event_type }));
      await rpc.account.setData({
        event_type: invocation.event_type,
        content: { ...existing, ...invocation.content },
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

const MENTION_USER_ID = /#\/(@[^?]+)/;

/** A mention pill reads as its display name in the body; commands take the id. */
function spellMentions(body: string, formatted: string | null | undefined): string {
  if (!formatted) return body;
  const links = new DOMParser().parseFromString(formatted, 'text/html').querySelectorAll('a[href]');
  let spelled = body;
  for (const link of links) {
    const userId = MENTION_USER_ID.exec(link.getAttribute('href') ?? '')?.[1];
    const label = link.textContent;
    if (userId && label) spelled = spelled.replace(label, () => decodeURIComponent(userId));
  }
  return spelled;
}

export async function runSlash(body: string, context: SlashContext): Promise<SlashResult> {
  let parsed = parseSlash(body, context.formatted ?? null);
  if (parsed.kind === 'usage') {
    const retried = parseSlash(spellMentions(body, context.formatted), context.formatted ?? null);
    if (retried.kind !== 'usage') parsed = retried;
  }

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
