import type { MemberView } from '#src/generated/MemberView';
import type { PackImageView } from '#src/generated/PackImageView';
import type { RoomSummary } from '#src/generated/RoomSummary';

import { searchReactionEmoji } from '#lib/emoji/emoji.js';
import { t } from '#lib/i18n.js';

import type { AutocompleteQuery, Suggestion } from './autocomplete';
import { descriptionKey, SLASH_COMMANDS } from './slash-commands';

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

function memberSuggestions(needle: string, members: readonly MemberView[]): Suggestion[] {
  return members
    .map((member) => ({
      member,
      name: member.display_name ?? member.user_id,
      localpart: localpartOf(member.user_id),
    }))
    .filter(
      ({ name, localpart }) =>
        name.toLowerCase().includes(needle) || localpart.toLowerCase().includes(needle)
    )
    .sort((left, right) => {
      const byPrefix = rank(
        left.name.toLowerCase().startsWith(needle) ||
          left.localpart.toLowerCase().startsWith(needle),
        right.name.toLowerCase().startsWith(needle) ||
          right.localpart.toLowerCase().startsWith(needle)
      );
      return byPrefix === 0 ? left.name.localeCompare(right.name) : byPrefix;
    })
    .slice(0, limit)
    .map(({ member, name }) => {
      const label = name.startsWith('@') ? name : `@${name}`;
      return {
        id: member.user_id,
        insert: label,
        label,
        detail: member.user_id,
        avatarUrl: member.avatar_url,
      };
    });
}

function emoteSuggestions(needle: string, emotes: readonly PackImageView[]): Suggestion[] {
  const packs = emotes
    .filter((image) => image.shortcode.toLowerCase().includes(needle))
    .sort((left, right) => {
      const byPrefix = rank(
        left.shortcode.toLowerCase().startsWith(needle),
        right.shortcode.toLowerCase().startsWith(needle)
      );
      return byPrefix === 0 ? left.shortcode.localeCompare(right.shortcode) : byPrefix;
    })
    .slice(0, limit)
    .map((image) => ({
      id: `pack:${image.shortcode}`,
      insert: `:${image.shortcode}:`,
      label: `:${image.shortcode}:`,
      detail: image.body,
      imageUrl: image.url,
    }));

  const native = searchReactionEmoji(needle, limit - packs.length).map((emoji) => ({
    id: `emoji:${emoji.emoji}`,
    insert: emoji.emoji,
    label: emoji.emoji,
    detail: `:${emoji.shortcode}:`,
  }));

  return [...packs, ...native];
}

function roomSuggestions(needle: string, rooms: readonly RoomSummary[]): Suggestion[] {
  return rooms
    .map((room) => ({ room, name: room.name ?? room.canonical_alias ?? room.room_id }))
    .filter(({ room, name }) => {
      const alias = room.canonical_alias ?? '';
      return name.toLowerCase().includes(needle) || alias.toLowerCase().includes(needle);
    })
    .sort((left, right) => {
      const byPrefix = rank(
        left.name.toLowerCase().startsWith(needle),
        right.name.toLowerCase().startsWith(needle)
      );
      return byPrefix === 0 ? left.name.localeCompare(right.name) : byPrefix;
    })
    .slice(0, limit)
    .map(({ room, name }) => ({
      id: room.canonical_alias ?? room.room_id,
      insert: name.startsWith('#') ? name : `#${name}`,
      label: name.startsWith('#') ? name : `#${name}`,
      detail: room.canonical_alias,
      avatarUrl: room.avatar_url,
    }));
}

function commandSuggestions(needle: string, translate: Translate): Suggestion[] {
  return SLASH_COMMANDS.filter((command) => command.name.includes(needle))
    .sort((left, right) => {
      const byPrefix = rank(left.name.startsWith(needle), right.name.startsWith(needle));
      return byPrefix === 0 ? left.name.localeCompare(right.name) : byPrefix;
    })
    .slice(0, limit)
    .map((command) => ({
      id: command.name,
      insert: `/${command.name}`,
      label: `/${command.name}`,
      detail: translate(descriptionKey(command)),
    }));
}

export type Translate = (key: string) => string;

export function suggestionsFor(
  query: AutocompleteQuery | null,
  members: readonly MemberView[],
  emotes: readonly PackImageView[],
  rooms: readonly RoomSummary[],
  translate: Translate = t
): Suggestion[] {
  if (!query) return [];
  const needle = query.query.toLowerCase();

  if (query.sigil === '/') return commandSuggestions(needle, translate);
  if (query.sigil === '@') {
    return [...roomMention(needle, translate), ...memberSuggestions(needle, members)].slice(
      0,
      limit
    );
  }
  if (query.sigil === '#') return roomSuggestions(needle, rooms);
  return emoteSuggestions(needle, emotes);
}
