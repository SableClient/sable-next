import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type { ImagePackView } from '#src/generated/protocol';

interface PackCache {
  snapshots: Map<string, ImagePackView[]>;
  refreshes: Map<string, Refresh>;
  generation: number;
}

interface Refresh {
  generation: number;
  result: Promise<ImagePackView[]>;
}

const caches = new WeakMap<object, PackCache>();
const packAccountDataEvents = new Set([
  'im.ponies.user_emotes',
  'im.ponies.emote_rooms',
  'm.image_pack.rooms',
]);

function cacheFor(commands: Pick<CoreCommands, 'imagePacks'>): PackCache {
  let cache = caches.get(commands);
  if (cache === undefined) {
    cache = { snapshots: new Map(), refreshes: new Map(), generation: 0 };
    caches.set(commands, cache);
  }
  return cache;
}

export function invalidatePacks(commands: Pick<CoreCommands, 'imagePacks'>): void {
  const cache = cacheFor(commands);
  cache.generation += 1;
  cache.snapshots.clear();
  cache.refreshes.clear();
}

export function isPackAccountDataEvent(eventType: string): boolean {
  return packAccountDataEvents.has(eventType);
}

export async function loadPacks(
  commands: Pick<CoreCommands, 'imagePacks'>,
  roomId: string,
  apply: (packs: ImagePackView[]) => void,
  accountId: string | null = null
): Promise<void> {
  const cache = cacheFor(commands);
  const key = `${accountId ?? ''}\u0000${roomId}`;
  const snapshot = cache.snapshots.get(key);
  if (snapshot !== undefined) {
    apply(snapshot);
    return;
  }

  const cached = await commands.imagePacks(roomId, true).catch((): ImagePackView[] => []);
  if (cached.length > 0) apply(cached);

  let refresh = cache.refreshes.get(key);
  if (refresh === undefined) {
    const generation = cache.generation;
    const result = commands
      .imagePacks(roomId)
      .then((packs) => {
        if (cache.generation === generation) cache.snapshots.set(key, packs);
        return packs;
      })
      .finally(() => {
        if (cache.refreshes.get(key)?.result === result) cache.refreshes.delete(key);
      });
    refresh = { generation, result };
    cache.refreshes.set(key, refresh);
  }
  try {
    const packs = await refresh.result;
    if (cache.generation === refresh.generation) apply(packs);
  } catch (error) {
    if (cached.length === 0) throw error;
  }
}
