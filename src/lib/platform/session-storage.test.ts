import { afterEach, expect, test, vi } from 'vitest';

import { deleteAccountWebStorage, resetWebStorage } from './session-storage.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubIndexedDB(existing: string[] | null) {
  const deleted: string[] = [];
  const cleared: IDBKeyRange[] = [];
  const state = {
    room_info: new Map([['!room:example.org', 'cached room']]),
    custom: new Map<string, unknown>([
      ['marker', 'cached'],
      ['sable.search.rooms', '["!room:example.org"]'],
      ['sable.search.chunk.!room:example.org.0', 'older documents'],
      ['sable.search.crawl', 'older-page'],
      ['sliding_sync_store::room-list', 'stale'],
    ]),
  };
  const factory: Record<string, unknown> = {
    deleteDatabase(name: string) {
      deleted.push(name);
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
    open(name: string) {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (existing !== null && !existing.includes(name)) {
          Object.defineProperty(request, 'error', { value: { name: 'AbortError' } });
          request.onerror?.call(request, new Event('error'));
          return;
        }
        Object.defineProperty(request, 'result', {
          value: name.endsWith('::matrix-sdk-state')
            ? fakeStateDatabase(state)
            : fakeCryptoDatabase(cleared),
        });
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
  };
  if (existing !== null) {
    factory.databases = () => Promise.resolve(existing.map((name) => ({ name })));
  }
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', {
    bound: (lower: string, upper: string) => ({ lower, upper }),
    upperBound: (upper: string, upperOpen: boolean) => ({ upper, upperOpen }),
    lowerBound: (lower: string, lowerOpen: boolean) => ({ lower, lowerOpen }),
  });
  return { deleted, cleared, state };
}

function fakeStateDatabase(state: Record<string, Map<string, unknown>>) {
  return {
    objectStoreNames: Object.assign(Object.keys(state), {
      contains: (name: string) => name in state,
    }),
    transaction() {
      const tx: Record<string, unknown> = {
        objectStore: (name: string) => ({
          clear: () => {
            state[name]?.clear();
          },
          get: (key: string) => ({ result: state[name]?.get(key) }),
          getAllKeys: (range: IDBKeyRange) => ({
            result: [...state[name].keys()].filter(
              (key) => key >= (range.lower as string) && key <= (range.upper as string)
            ),
          }),
          put: (value: unknown, key: string) => state[name]?.set(key, value),
          delete(range: IDBKeyRange) {
            for (const key of state[name].keys()) {
              if (
                (range.lower !== undefined && key > (range.lower as string)) ||
                (range.upper !== undefined && key < (range.upper as string))
              ) {
                state[name]?.delete(key);
              }
            }
          },
        }),
      };
      queueMicrotask(() => (tx.oncomplete as (() => void) | undefined)?.());
      return tx;
    },
    close() {},
  };
}

function fakeCryptoDatabase(cleared: IDBKeyRange[]) {
  return {
    objectStoreNames: { contains: (store: string) => store === 'core' },
    transaction() {
      const tx: Record<string, unknown> = {
        objectStore: () => ({
          delete(range: IDBKeyRange) {
            cleared.push(range);
          },
        }),
      };
      queueMicrotask(() => {
        (tx.oncomplete as (() => void) | undefined)?.();
      });
      return tx;
    },
    close() {},
  };
}

test('removes the rebuildable stores but keeps the session, crypto stores and search index', async () => {
  const { deleted } = stubIndexedDB([
    'sable-next-session',
    'sable-next-account-a1',
    'sable-next-account-a1::matrix-sdk-state',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
    'sable-next-account-a1::sable-search',
    'sable-next-account-a1::matrix-sdk-crypto',
    'sable-next-account-a1::matrix-sdk-crypto-meta',
    'unrelated-database',
  ]);

  await resetWebStorage();

  expect(deleted).toEqual([
    'sable-next-account-a1',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
  ]);
});

test('clears the HTTP caches too', async () => {
  stubIndexedDB([]);
  const cleared: string[] = [];
  vi.stubGlobal('caches', {
    keys: () => Promise.resolve(['sable-media', 'workbox-precache']),
    delete: (name: string) => {
      cleared.push(name);
      return Promise.resolve(true);
    },
  });

  await resetWebStorage();

  expect(cleared).toEqual(['sable-media', 'workbox-precache']);
});

test('derives every account store when database listing is unavailable', async () => {
  const { deleted } = stubIndexedDB(null);

  await resetWebStorage(['a1']);

  expect(deleted).toEqual([
    'sable-next',
    'sable-next::event_cache',
    'sable-next::media',
    'sable-next-account-a1',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
  ]);
});

test('keeps legacy search documents and checkpoints in the SDK state database', async () => {
  const { state, deleted } = stubIndexedDB(['sable-next-account-a1::matrix-sdk-state']);

  await resetWebStorage(['a1']);

  expect(deleted).toEqual([]);
  expect(state.room_info.size).toBe(0);
  expect([...state.custom]).toEqual([
    ['sable.search.rooms', '["!room:example.org"]'],
    ['sable.search.chunk.!room:example.org.0', 'older documents'],
    ['sable.search.crawl', 'older-page'],
  ]);
});

test('lists unconverted legacy rooms before clearing their cached membership', async () => {
  const { state } = stubIndexedDB(['sable-next-account-a1::matrix-sdk-state']);
  state.custom.set(
    'sable.search.rooms',
    Array.from(zlibSync(new TextEncoder().encode('["!room:example.org"]')))
  );
  state.custom.set('sable.search.documents.!legacy:example.org', 'legacy documents');

  await resetWebStorage(['a1']);

  expect(state.room_info.size).toBe(0);
  expect(state.custom.get('sable.search.documents.!legacy:example.org')).toBe('legacy documents');
  expect(
    JSON.parse(
      new TextDecoder().decode(Uint8Array.from(state.custom.get('sable.search.rooms') as number[]))
    )
  ).toEqual(['!room:example.org', '!legacy:example.org']);
});

test('drops the sliding sync position the crypto store keeps', async () => {
  const { cleared } = stubIndexedDB([
    'sable-next-account-a1::matrix-sdk-state',
    'sable-next-account-a1::matrix-sdk-crypto',
  ]);

  await resetWebStorage();

  expect(cleared).toEqual([{ lower: 'sliding_sync_store::', upper: 'sliding_sync_store::\uffff' }]);
});

test('deletes every store of the signed-out account, crypto included', async () => {
  const { deleted } = stubIndexedDB([
    'sable-next-session',
    'sable-next',
    'sable-next-account-a1',
    'sable-next-account-a1::matrix-sdk-state',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
    'sable-next-account-a1::sable-search',
    'sable-next-account-a1::matrix-sdk-crypto',
    'sable-next-account-a1::matrix-sdk-crypto-meta',
    'sable-next-account-a10::matrix-sdk-state',
    'sable-next-account-a2::matrix-sdk-crypto',
  ]);

  await deleteAccountWebStorage('a1');

  expect(deleted).toEqual([
    'sable-next-account-a1',
    'sable-next-account-a1::matrix-sdk-state',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
    'sable-next-account-a1::sable-search',
    'sable-next-account-a1::matrix-sdk-crypto',
    'sable-next-account-a1::matrix-sdk-crypto-meta',
  ]);
});

test('derives the account stores when database listing is unavailable', async () => {
  const { deleted } = stubIndexedDB(null);

  await deleteAccountWebStorage('a1');

  expect(deleted).toEqual([
    'sable-next-account-a1',
    'sable-next-account-a1::matrix-sdk-state',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
    'sable-next-account-a1::sable-search',
    'sable-next-account-a1::matrix-sdk-crypto',
    'sable-next-account-a1::matrix-sdk-crypto-meta',
  ]);
});
import { zlibSync } from 'fflate';
