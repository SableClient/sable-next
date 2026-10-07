import { emojiRawRecords } from 'virtual:sable-emoji-data';

import type { EmojiGroupId } from './emoji-groups.js';
import { emojiGroupOrder } from './emoji-groups.js';

export { QUICK_REACTIONS } from './quick-reactions.js';
export type { EmojiGroupId } from './emoji-groups.js';

export interface ReactionEmoji {
  emoji: string;
  shortcode: string;
  keywords: readonly string[];
}

export interface EmojiGroup {
  id: EmojiGroupId;
  emojis: ReactionEmoji[];
}

function build(): {
  groups: EmojiGroup[];
  all: ReactionEmoji[];
  byEmoji: Map<string, string>;
  byShortcode: Map<string, string>;
} {
  const groups: EmojiGroup[] = emojiGroupOrder.map((id) => ({ id, emojis: [] }));
  const all: ReactionEmoji[] = [];
  const byEmoji = new Map<string, string>();
  const byShortcode = new Map<string, string>();

  for (const [unicode, codes, keywords, groupIndex] of emojiRawRecords) {
    const shortcode = codes[0];
    if (!shortcode) continue;

    const item: ReactionEmoji = {
      emoji: unicode,
      shortcode,
      keywords,
    };

    const targetGroup = groups[groupIndex];
    targetGroup.emojis.push(item);
    all.push(item);
    byEmoji.set(unicode, shortcode);
    for (const code of codes) {
      if (!byShortcode.has(code)) {
        byShortcode.set(code, unicode);
      }
    }
  }

  return {
    groups,
    all,
    byEmoji,
    byShortcode,
  };
}

const built = build();

export const emojiGroups: readonly EmojiGroup[] = built.groups;
export const REACTION_EMOJI: readonly ReactionEmoji[] = built.all;

export function searchReactionEmoji(query: string, limit = 24): ReactionEmoji[] {
  const needle = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!needle) return [];

  const scored: { entry: ReactionEmoji; score: number }[] = [];

  for (const entry of built.all) {
    if (entry.emoji === query) scored.push({ entry, score: 0 });
    else if (entry.shortcode === needle) scored.push({ entry, score: 1 });
    else if (entry.shortcode.startsWith(needle)) scored.push({ entry, score: 2 });
    else if (entry.keywords.some((keyword) => keyword === needle)) scored.push({ entry, score: 3 });
    else if (entry.shortcode.includes(needle)) scored.push({ entry, score: 4 });
    else if (entry.keywords.some((keyword) => keyword.startsWith(needle))) {
      scored.push({ entry, score: 5 });
    }
  }

  return scored
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map((match) => match.entry);
}

export function shortcodeFor(emoji: string): string | null {
  return built.byEmoji.get(emoji) ?? null;
}

export function emojiForShortcode(shortcode: string): string | null {
  return built.byShortcode.get(shortcode.toLowerCase()) ?? null;
}
