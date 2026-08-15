import emojibaseShortcodes from 'emojibase-data/en/shortcodes/emojibase.json';
import joypixelsShortcodes from 'emojibase-data/en/shortcodes/joypixels.json';
import compact from 'emojibase-data/en/compact.json';

export interface ReactionEmoji {
  emoji: string;
  shortcode: string;
  keywords: string[];
}

export type EmojiGroupId =
  | 'people'
  | 'nature'
  | 'food'
  | 'activity'
  | 'travel'
  | 'object'
  | 'symbol'
  | 'flag';

export interface EmojiGroup {
  id: EmojiGroupId;
  emojis: ReactionEmoji[];
}

export const QUICK_REACTIONS = ['🎉', '👀', '✅', '🙏', '🔥', '💜'];

// Group 2 (component) has no bucket, so a miss here is expected.
const groupOf: Partial<Record<number, EmojiGroupId>> = {
  0: 'people',
  1: 'people',
  3: 'nature',
  4: 'food',
  5: 'travel',
  6: 'activity',
  7: 'object',
  8: 'symbol',
  9: 'flag',
};

const shortcodeMaps = [joypixelsShortcodes, emojibaseShortcodes] as Record<
  string,
  string | string[] | undefined
>[];

function shortcodesFor(hexcode: string): string[] {
  const found: string[] = [];
  for (const map of shortcodeMaps) {
    const entry = map[hexcode];
    if (typeof entry === 'string') found.push(entry);
    else if (Array.isArray(entry)) found.push(...entry);
  }
  return found;
}

const order: EmojiGroupId[] = [
  'people',
  'nature',
  'food',
  'activity',
  'travel',
  'object',
  'symbol',
  'flag',
];

function build(): { groups: EmojiGroup[]; all: ReactionEmoji[]; byEmoji: Map<string, string> } {
  const buckets = new Map<EmojiGroupId, ReactionEmoji[]>();
  const all: ReactionEmoji[] = [];
  const byEmoji = new Map<string, string>();

  for (const entry of compact) {
    const id: EmojiGroupId | undefined = groupOf[entry.group ?? 8];
    if (id === undefined) continue;

    const codes = shortcodesFor(entry.hexcode);
    const shortcode = codes[0];
    if (!shortcode) continue;

    const item: ReactionEmoji = {
      emoji: entry.unicode,
      shortcode,
      keywords: [...new Set([...codes.slice(1), ...entry.label.toLowerCase().split(/\s+/)])],
    };

    const bucket = buckets.get(id);
    if (bucket) bucket.push(item);
    else buckets.set(id, [item]);
    all.push(item);
    byEmoji.set(entry.unicode, shortcode);
  }

  return {
    groups: order.map((id) => ({ id, emojis: buckets.get(id) ?? [] })),
    all,
    byEmoji,
  };
}

const built = build();

export const emojiGroups: readonly EmojiGroup[] = built.groups;
export const REACTION_EMOJI: readonly ReactionEmoji[] = built.all;

export function searchReactionEmoji(query: string, limit = 24): ReactionEmoji[] {
  const needle = query.trim().toLowerCase().replace(/^:/, '');
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
