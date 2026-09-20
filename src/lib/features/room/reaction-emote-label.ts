import type { ImagePackView } from '#src/generated/protocol';

const packs = new Map<string, ImagePackView[]>();
const pending = new Map<string, Promise<ImagePackView[]>>();

export function isCustomReaction(key: string): boolean {
  return key.startsWith('mxc://');
}

export function reactionEmoteLabel(
  key: string,
  imagePacks: readonly ImagePackView[],
  fallback: string
): string {
  if (!isCustomReaction(key)) return key;

  const image = imagePacks.flatMap((pack) => pack.images).find((image) => image.url === key);
  return image === undefined ? fallback : `:${image.shortcode}:`;
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
