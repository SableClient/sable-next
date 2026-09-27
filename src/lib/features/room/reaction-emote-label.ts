import QuickLRU from 'quick-lru';

import type { ImagePackView, ReactionShortcodeView } from '#src/generated/protocol';

const packs = new Map<string, ImagePackView[]>();
const pending = new Map<string, Promise<ImagePackView[]>>();
const sentShortcodes = new QuickLRU<string, Promise<ReadonlyMap<string, string>>>({
  maxSize: 512,
});
const NO_SHORTCODES: ReadonlyMap<string, string> = new Map();

export function isCustomReaction(key: string): boolean {
  return key.startsWith('mxc://');
}

export function reactionShortcode(
  key: string,
  imagePacks: readonly ImagePackView[],
  sent: ReadonlyMap<string, string> = NO_SHORTCODES
): string | null {
  if (!isCustomReaction(key)) return null;
  const name =
    sent.get(key) ??
    imagePacks.flatMap((pack) => pack.images).find((image) => image.url === key)?.shortcode;
  return name === undefined ? null : `:${name}:`;
}

export function reactionEmoteLabel(
  key: string,
  imagePacks: readonly ImagePackView[],
  fallback: string,
  sent: ReadonlyMap<string, string> = NO_SHORTCODES
): string {
  if (!isCustomReaction(key)) return key;
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

export async function loadReactionEmotePacks(
  roomId: string,
  imagePacks: (roomId: string) => Promise<ImagePackView[]>
): Promise<ImagePackView[]> {
  const cached = packs.get(roomId);
  if (cached !== undefined) return cached;

  let load = pending.get(roomId);
  if (load === undefined) {
    load = imagePacks(roomId)
      .then((loaded) => {
        packs.set(roomId, loaded);
        return loaded;
      })
      .finally(() => {
        pending.delete(roomId);
      });
    pending.set(roomId, load);
  }
  return load;
}
