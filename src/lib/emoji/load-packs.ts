import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type { ImagePackView } from '#src/generated/protocol';

type PackCommands = Pick<CoreCommands, 'imagePackListing'>;

interface Snapshot {
  packs: ImagePackView[];
  takenAt: number;
}

interface PackCache {
  snapshots: Map<string, Snapshot>;
  refreshes: Map<string, Refresh>;
  generation: number;
}

interface Refresh {
  generation: number;
  result: Promise<{ packs: ImagePackView[]; complete: boolean }>;
}

const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 64;
const caches = new WeakMap<object, PackCache>();
const packAccountDataEvents = new Set([
  'im.ponies.user_emotes',
  'im.ponies.emote_rooms',
  'm.image_pack.rooms',
]);

function cacheFor(commands: PackCommands): PackCache {
  let cache = caches.get(commands);
  if (cache === undefined) {
    cache = { snapshots: new Map(), refreshes: new Map(), generation: 0 };
    caches.set(commands, cache);
  }
  return cache;
}

export function invalidatePacks(commands: PackCommands): void {
  const cache = cacheFor(commands);
  cache.generation += 1;
  cache.snapshots.clear();
  cache.refreshes.clear();
}

function readSnapshot(cache: PackCache, key: string): Snapshot | undefined {
  const snapshot = cache.snapshots.get(key);
  if (snapshot === undefined) return undefined;
  cache.snapshots.delete(key);
  cache.snapshots.set(key, snapshot);
  return snapshot;
}

function keepSnapshot(cache: PackCache, key: string, packs: ImagePackView[]): void {
  cache.snapshots.delete(key);
  cache.snapshots.set(key, { packs, takenAt: Date.now() });
  if (cache.snapshots.size <= MAX_SNAPSHOTS) return;
  const oldest = cache.snapshots.keys().next();
  if (oldest.done !== true) cache.snapshots.delete(oldest.value);
}

export function isPackAccountDataEvent(eventType: string): boolean {
  return packAccountDataEvents.has(eventType);
}

export async function loadPacks(
  commands: PackCommands,
  roomId: string,
  apply: (packs: ImagePackView[]) => void,
  accountId: string | null = null
): Promise<boolean> {
  const cache = cacheFor(commands);
  const key = `${accountId ?? ''}\u0000${roomId}`;
  const snapshot = readSnapshot(cache, key);
  if (snapshot !== undefined) {
    apply(snapshot.packs);
    if (Date.now() - snapshot.takenAt < SNAPSHOT_MAX_AGE_MS) return true;
  }

  const cached =
    snapshot?.packs ??
    (await commands
      .imagePackListing(roomId, true)
      .then((listing) => listing.packs)
      .catch((): ImagePackView[] => []));
  if (snapshot === undefined && cached.length > 0) apply(cached);

  let refresh = cache.refreshes.get(key);
  if (refresh === undefined) {
    const generation = cache.generation;
    const result = commands
      .imagePackListing(roomId)
      .then((listing) => {
        if (listing.complete && cache.generation === generation) {
          keepSnapshot(cache, key, listing.packs);
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
      return await loadPacks(commands, roomId, apply, accountId);
    }
    apply(packs);
    return complete;
  } catch (error) {
    if (cached.length === 0) throw error;
    return false;
  }
}
