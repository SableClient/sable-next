export const emojiGroupOrder = [
  'people',
  'nature',
  'food',
  'activity',
  'travel',
  'object',
  'symbol',
  'flag',
] as const;

export type EmojiGroupId = (typeof emojiGroupOrder)[number];
