import type {
  ImagePackView,
  MemberView,
  PackImageView,
  RoomListItemView,
} from '#src/generated/protocol';

import { REACTION_EMOJI, searchReactionEmoji } from '#lib/emoji/emoji.js';
import { packName } from '#lib/emoji/pack-name.js';
import { rootSpaceNames } from '#lib/rooms/spaces.js';
import { t } from '#lib/i18n.js';

import { adminSuggestions, type AdminCommand, type AdminScope } from './admin-commands';
import type { AutocompleteQuery, Suggestion } from './autocomplete';
import { botCommandId, botCommandNames, type BotCommand } from './bot-commands';
import { descriptionKey, slashCommandNames } from './slash-commands';
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

const atName = (name: string): string => (name.startsWith('@') ? name : `@${name}`);

function memberSuggestions(needle: string, members: readonly MemberView[]): Suggestion[] {
  return members
    .map((member) => ({
      member,
      name: member.real_name ?? member.user_id,
      shown: member.display_name ?? member.user_id,
      localpart: localpartOf(member.user_id),
    }))
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

export type PackEmote = PackImageView & { pack: ImagePackView };

export function emoteSuggestionId(image: PackImageView): string {
  return `pack:${image.shortcode} ${image.url}`;
}

function emoteSuggestions(
  needle: string,
  emotes: readonly PackEmote[],
  translate: Translate
): Suggestion[] {
  const ids = new Set<string>();
  const packs = emotes
    .filter((image) => image.shortcode.toLowerCase().includes(needle))
    .sort((left, right) => {
      const byPrefix = rank(
        left.shortcode.toLowerCase().startsWith(needle),
        right.shortcode.toLowerCase().startsWith(needle)
      );
      return (
        byPrefix ||
        byUsage(emoteSuggestionId(left), emoteSuggestionId(right)) ||
        left.shortcode.localeCompare(right.shortcode)
      );
    })
    .filter((image) => {
      const id = emoteSuggestionId(image);
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    })
    .slice(0, limit)
    .map((image) => ({
      id: emoteSuggestionId(image),
      insert: `:${image.shortcode}:`,
      label: `:${image.shortcode}:`,
      detail: [image.body, packName(image.pack, translate)].filter(Boolean).join(' · '),
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
        rank(isExact(left.suggestion), isExact(right.suggestion)) ||
        byUsage(left.suggestion.id, right.suggestion.id) ||
        left.index - right.index
    )
    .slice(0, limit)
    .map(({ suggestion }) => suggestion);
}

function roomSuggestions(needle: string, rooms: readonly RoomListItemView[]): Suggestion[] {
  const normalized = (text: string) => text.toLowerCase().replace(/\s/g, '');
  const normalizedNeedle = normalized(needle);
  if (!normalizedNeedle) return [];
  const seen = new Set<string>();
  const spaceNames = rootSpaceNames(rooms);
  return rooms
    .map((room) => {
      const name = room.name ?? room.canonical_alias ?? room.room_id;
      return {
        room,
        name,
        label: room.display_name,
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
    .map(({ room, name, label }) => ({
      id: room.canonical_alias ?? room.room_id,
      insert: name.startsWith('#') ? name : `#${name}`,
      label: label.startsWith('#') ? label : `#${label}`,
      detail:
        [spaceNames.get(room.room_id), room.canonical_alias].filter(Boolean).join(' · ') || null,
      avatarUrl: room.display_avatar_url,
    }))
    .filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, limit);
}

function commandSuggestions(
  needle: string,
  translate: Translate,
  botCommands: readonly BotCommand[]
): Suggestion[] {
  const names = slashCommandNames();
  const builtIn = new Set(names);
  const local = names.map((name) => ({
    name,
    names: [name],
    suggestion: {
      id: name,
      insert: `/${name}`,
      label: `/${name}`,
      detail: translate(descriptionKey(name)),
    },
  }));
  const bots = botCommands
    .filter((command) => !builtIn.has(command.command.toLowerCase()))
    .map((command) => {
      const bot = command.sender_name ?? command.sender;
      return {
        name: command.command.toLowerCase(),
        names: botCommandNames(command).map((name) => name.toLowerCase()),
        suggestion: {
          id: botCommandId(command),
          insert: `/${command.command}`,
          label: `/${command.command}`,
          detail: command.description ? `${bot} · ${command.description}` : bot,
          avatarUrl: command.sender_avatar,
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
  emotes: readonly PackEmote[],
  rooms: readonly RoomListItemView[],
  translate: Translate = t,
  admin: AdminScope = null,
  adminCommands: readonly AdminCommand[] | null = null,
  botCommands: readonly BotCommand[] = []
): Suggestion[] {
  if (!query) return [];
  if (query.sigil === '!') return adminSuggestions(query.query, admin, adminCommands);
  const needle = query.query.toLowerCase();

  if (query.sigil === '/') return commandSuggestions(needle, translate, botCommands);
  if (query.sigil === '@') {
    return [...roomMention(needle, translate), ...memberSuggestions(needle, members)].slice(
      0,
      limit
    );
  }
  if (query.sigil === '#') return roomSuggestions(needle, rooms);
  return emoteSuggestions(needle, emotes, translate);
}
