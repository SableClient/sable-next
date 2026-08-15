import type { MemberView } from '@/generated/MemberView';
import type { PackImageView } from '@/generated/PackImageView';

import { searchReactionEmoji } from '$lib/emoji/emoji';

import type { AutocompleteQuery, Suggestion } from './autocomplete';

const limit = 8;

function localpartOf(userId: string): string {
  return userId.slice(1).split(':')[0] ?? '';
}

function rank(left: boolean, right: boolean): number {
  if (left === right) return 0;
  return left ? -1 : 1;
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
    .map(({ member, name }) => ({
      id: member.user_id,
      insert: name,
      label: name,
      detail: member.user_id,
      avatarUrl: member.avatar_url,
    }));
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

export function suggestionsFor(
  query: AutocompleteQuery | null,
  members: readonly MemberView[],
  emotes: readonly PackImageView[]
): Suggestion[] {
  if (!query) return [];
  const needle = query.query.toLowerCase();

  return query.sigil === '@'
    ? memberSuggestions(needle, members)
    : emoteSuggestions(needle, emotes);
}
