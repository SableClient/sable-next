import type { MemberView, PackImageView, RoomSummary } from '#src/generated/protocol';

import { REACTION_EMOJI, searchReactionEmoji } from '#lib/emoji/emoji.js';
import { t } from '#lib/i18n.js';

import { adminSuggestions, type AdminCommand, type AdminScope } from './admin-commands';
import type { AutocompleteQuery, Suggestion } from './autocomplete';
import { botCommandId, botCommandNames, type BotCommand } from './bot-commands';
import { descriptionKey, SLASH_COMMANDS } from './slash-commands';
import { byUsage, usageOf } from './suggestion-usage';

const limit = 8;

function localpartOf(userId: string): string {
  return userId.slice(1).split(':')[0] ?? '';
}

function rank(left: boolean, right: boolean): number {
  if (left === right) return 0;
  return left ? -1 : 1;
}

export const ROOM_MENTION = '@room';

function roomMention(needle: string, translate: Translate): Suggestion[] {
  if (!'room'.startsWith(needle)) return [];
  return [
    {
      id: ROOM_MENTION,
      insert: ROOM_MENTION,
      label: ROOM_MENTION,
      detail: translate('composer.roomMention'),
    },
  ];
}

export type DisplayName = (userId: string, fallback: string) => string;

const atName = (name: string): string => (name.startsWith('@') ? name : `@${name}`);

function memberSuggestions(
  needle: string,
  members: readonly MemberView[],
  displayName: DisplayName
): Suggestion[] {
  return members
    .map((member) => {
      const name = member.display_name ?? member.user_id;
      return {
        member,
        name,
        shown: displayName(member.user_id, name),
        localpart: localpartOf(member.user_id),
      };
    })
    .map((entry) => ({
      ...entry,
      keys: [entry.shown, entry.name, entry.localpart].map((key) => key.toLowerCase()),
    }))
    .filter(({ keys }) => keys.some((key) => key.includes(needle)))
    .sort((left, right) => {
      const byPrefix = rank(
        left.keys.some((key) => key.startsWith(needle)),
        right.keys.some((key) => key.startsWith(needle))
      );
      return (
        byPrefix ||
        byUsage(left.member.user_id, right.member.user_id) ||
        left.shown.localeCompare(right.shown)
      );
    })
    .slice(0, limit)
    .map(({ member, name, shown }) => ({
      id: member.user_id,
      insert: atName(name),
      label: atName(shown),
      detail: member.user_id,
      avatarUrl: member.avatar_url,
    }));
}

function emoteSuggestions(needle: string, emotes: readonly PackImageView[]): Suggestion[] {
  const shortcodes = new Set<string>();
  const packs = emotes
    .filter((image) => image.shortcode.toLowerCase().includes(needle))
    .sort((left, right) => {
      const byPrefix = rank(
        left.shortcode.toLowerCase().startsWith(needle),
        right.shortcode.toLowerCase().startsWith(needle)
      );
      return (
        byPrefix ||
        byUsage(`pack:${left.shortcode}`, `pack:${right.shortcode}`) ||
        left.shortcode.localeCompare(right.shortcode)
      );
    })
    .filter((image) => {
      if (shortcodes.has(image.shortcode)) return false;
      shortcodes.add(image.shortcode);
      return true;
    })
    .slice(0, limit)
    .map((image) => ({
      id: `pack:${image.shortcode}`,
      insert: `:${image.shortcode}:`,
      label: `:${image.shortcode}:`,
      detail: image.body,
      imageUrl: image.url,
    }));

  const emojiMatches = needle ? searchReactionEmoji(needle, Infinity) : REACTION_EMOJI;
  const native = emojiMatches.map((emoji) => ({
    id: `emoji:${emoji.emoji}`,
    insert: emoji.emoji,
    label: emoji.emoji,
    detail: `:${emoji.shortcode}:`,
  }));

  const exact = `:${needle}:`;
  const isExact = (suggestion: Suggestion) =>
    suggestion.label === exact || suggestion.detail === exact;
  const reserved = Math.min(packs.length, 3);
  const pool = native.filter(
    (suggestion, index) => index < limit - reserved || usageOf(suggestion.id) > 0
  );
  return [...pool, ...packs]
    .map((suggestion, index) => ({ suggestion, index }))
    .sort(
      (left, right) =>
        byUsage(left.suggestion.id, right.suggestion.id) ||
        rank(isExact(left.suggestion), isExact(right.suggestion)) ||
        left.index - right.index
    )
    .slice(0, limit)
    .map(({ suggestion }) => suggestion);
}

function roomSuggestions(needle: string, rooms: readonly RoomSummary[]): Suggestion[] {
  const normalized = (text: string) => text.toLowerCase().replace(/\s/g, '');
  const normalizedNeedle = normalized(needle);
  if (!normalizedNeedle) return [];
  const seen = new Set<string>();
  return rooms
    .map((room) => {
      const name = room.name ?? room.canonical_alias ?? room.room_id;
      return {
        room,
        name,
        searchName: normalized(name),
        searchAlias: normalized(room.canonical_alias ?? ''),
      };
    })
    .filter(
      ({ searchName, searchAlias }) =>
        searchName.includes(normalizedNeedle) || searchAlias.includes(normalizedNeedle)
    )
    .sort((left, right) => {
      const byPrefix = rank(
        left.searchName.startsWith(normalizedNeedle),
        right.searchName.startsWith(normalizedNeedle)
      );
      return (
        byPrefix ||
        byUsage(
          left.room.canonical_alias ?? left.room.room_id,
          right.room.canonical_alias ?? right.room.room_id
        ) ||
        left.name.localeCompare(right.name)
      );
    })
    .map(({ room, name }) => ({
      id: room.canonical_alias ?? room.room_id,
      insert: name.startsWith('#') ? name : `#${name}`,
      label: name.startsWith('#') ? name : `#${name}`,
      detail: room.canonical_alias,
      avatarUrl: room.avatar_url,
    }))
    .filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, limit);
}

const builtIn = new Set(SLASH_COMMANDS.map((command) => command.name));

function commandSuggestions(
  needle: string,
  translate: Translate,
  botCommands: readonly BotCommand[]
): Suggestion[] {
  const local = SLASH_COMMANDS.map((command) => ({
    name: command.name,
    names: [command.name],
    suggestion: {
      id: command.name,
      insert: `/${command.name}`,
      label: `/${command.name}`,
      detail: translate(descriptionKey(command)),
    },
  }));
  const bots = botCommands
    .filter((command) => !builtIn.has(command.command.toLowerCase()))
    .map((command) => {
      const bot = command.senderName ?? command.sender;
      return {
        name: command.command.toLowerCase(),
        names: botCommandNames(command).map((name) => name.toLowerCase()),
        suggestion: {
          id: botCommandId(command),
          insert: `/${command.command}`,
          label: `/${command.command}`,
          detail: command.description ? `${bot} · ${command.description}` : bot,
          avatarUrl: command.senderAvatar,
        },
      };
    });

  return [...local, ...bots]
    .filter(({ names }) => names.some((name) => name.includes(needle)))
    .sort((left, right) => {
      const byPrefix = rank(
        left.names.some((name) => name.startsWith(needle)),
        right.names.some((name) => name.startsWith(needle))
      );
      return (
        byPrefix ||
        byUsage(left.suggestion.id, right.suggestion.id) ||
        left.name.localeCompare(right.name)
      );
    })
    .slice(0, limit)
    .map(({ suggestion }) => suggestion);
}

export type Translate = (key: string) => string;

export function suggestionsFor(
  query: AutocompleteQuery | null,
  members: readonly MemberView[],
  emotes: readonly PackImageView[],
  rooms: readonly RoomSummary[],
  translate: Translate = t,
  admin: AdminScope = null,
  adminCommands: readonly AdminCommand[] | null = null,
  botCommands: readonly BotCommand[] = [],
  displayName: DisplayName = (_userId, fallback) => fallback
): Suggestion[] {
  if (!query) return [];
  if (query.sigil === '!') return adminSuggestions(query.query, admin, adminCommands);
  const needle = query.query.toLowerCase();

  if (query.sigil === '/') return commandSuggestions(needle, translate, botCommands);
  if (query.sigil === '@') {
    return [
      ...roomMention(needle, translate),
      ...memberSuggestions(needle, members, displayName),
    ].slice(
      0,
      limit
    );
  }
  if (query.sigil === '#') return roomSuggestions(needle, rooms);
  return emoteSuggestions(needle, emotes);
}
