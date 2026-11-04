import QuickLRU from 'quick-lru';

import { imagePackListing } from '#lib/core/api/packs.js';
import type { CoreEvent, ImagePackView, Rpc } from '#src/generated/protocol';

type PackRpc = Pick<Rpc, 'packs'>;

interface PackCache {
  snapshots: QuickLRU<string, ImagePackView[]>;
  refreshes: Map<string, Refresh>;
  generation: number;
}

interface Refresh {
  generation: number;
  result: Promise<{ packs: ImagePackView[]; complete: boolean }>;
}

const MAX_SNAPSHOTS = 64;
const caches = new WeakMap<object, PackCache>();
const packAccountDataEvents = new Set([
  'im.ponies.user_emotes',
  'im.ponies.emote_rooms',
  'm.image_pack.rooms',
]);

function cacheFor(rpc: PackRpc): PackCache {
  let cache = caches.get(rpc);
  if (cache === undefined) {
    cache = {
      snapshots: new QuickLRU({ maxSize: MAX_SNAPSHOTS }),
      refreshes: new Map(),
      generation: 0,
    };
    caches.set(rpc, cache);
  }
  return cache;
}

export function invalidatePacks(rpc: PackRpc): void {
  const cache = cacheFor(rpc);
  cache.generation += 1;
  cache.snapshots.clear();
  cache.refreshes.clear();
}

export function isPackAccountDataEvent(eventType: string): boolean {
  return packAccountDataEvents.has(eventType);
}

export function isPackChange(event: CoreEvent): boolean {
  return (
    event.type === 'image_packs_changed' ||
    (event.type === 'account_data_changed' && isPackAccountDataEvent(event.event_type))
  );
}

export async function loadPacks(
  rpc: PackRpc,
  roomId: string,
  apply: (packs: ImagePackView[]) => void,
  accountId: string | null = null
): Promise<boolean> {
  const cache = cacheFor(rpc);
  const key = `${accountId ?? ''}\u0000${roomId}`;
  const snapshot = cache.snapshots.get(key);
  if (snapshot !== undefined) {
    apply(snapshot);
    return true;
  }

  const cached = await imagePackListing(rpc, roomId, true)
    .then((listing) => listing.packs)
    .catch((): ImagePackView[] => []);
  if (cached.length > 0) apply(cached);

  let refresh = cache.refreshes.get(key);
  if (refresh === undefined) {
    const generation = cache.generation;
    const result = imagePackListing(rpc, roomId)
      .then((listing) => {
        if (listing.complete && cache.generation === generation) {
          cache.snapshots.set(key, listing.packs);
        }
        return listing;
      })
      .finally(() => {
        if (cache.refreshes.get(key)?.result === result) cache.refreshes.delete(key);
      });
    refresh = { generation, result };
    cache.refreshes.set(key, refresh);
  }
  try {
    const { packs, complete } = await refresh.result;
    if (cache.generation !== refresh.generation) {
      return await loadPacks(rpc, roomId, apply, accountId);
    }
    apply(packs);
    return complete;
  } catch (error) {
    if (cached.length === 0) throw error;
    return false;
  }
}
