import QuickLRU from 'quick-lru';

import { graphemes } from '#lib/graphemes.js';
import type { ImagePackView, ReactionShortcodeView } from '#src/generated/protocol';

const sentShortcodes = new QuickLRU<string, Promise<ReadonlyMap<string, string>>>({
  maxSize: 512,
});
const NO_SHORTCODES: ReadonlyMap<string, string> = new Map();

export function isCustomReaction(key: string): boolean {
  return key.startsWith('mxc://');
}

const MAX_REACTION_GRAPHEMES = 64;

export function reactionText(key: string): string {
  if (key.length <= MAX_REACTION_GRAPHEMES) return key;
  let out = '';
  let count = 0;
  for (const { segment } of graphemes.segment(key)) {
    if (count === MAX_REACTION_GRAPHEMES) return `${out}…`;
    out += segment;
    count += 1;
  }
  return out;
}

export function reactionShortcode(
  key: string,
  imagePacks: readonly ImagePackView[],
  sent: ReadonlyMap<string, string> = NO_SHORTCODES
): string | null {
  if (!isCustomReaction(key)) return null;

  const sentName = sent.get(key);
  if (sentName !== undefined) return `:${sentName}:`;

  for (const pack of imagePacks)
    for (const image of pack.images) if (image.url === key) return `:${image.shortcode}:`;

  return null;
}

export function reactionEmoteLabel(
  key: string,
  imagePacks: readonly ImagePackView[],
  fallback: string,
  sent: ReadonlyMap<string, string> = NO_SHORTCODES
): string {
  if (!isCustomReaction(key)) return reactionText(key);
  return reactionShortcode(key, imagePacks, sent) ?? fallback;
}

export function loadReactionShortcodes(
  roomId: string,
  eventId: string,
  keys: readonly string[],
  fetch: () => Promise<ReactionShortcodeView[]>
): Promise<ReadonlyMap<string, string>> {
  const cacheKey = [roomId, eventId, ...[...keys].sort()].join('\n');
  let load = sentShortcodes.get(cacheKey);
  if (load === undefined) {
    load = fetch().then(
      (views) => new Map(views.map((view) => [view.key, view.shortcode])),
      (error: unknown) => {
        sentShortcodes.delete(cacheKey);
        throw error;
      }
    );
    sentShortcodes.set(cacheKey, load);
  }
  return load;
}
