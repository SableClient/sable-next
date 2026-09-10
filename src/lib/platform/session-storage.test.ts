import { afterEach, expect, test, vi } from 'vitest';

import { deleteAccountWebStorage, resetWebStorage } from './session-storage.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubIndexedDB(existing: string[] | null) {
  const deleted: string[] = [];
  const cleared: IDBKeyRange[] = [];
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
        Object.defineProperty(request, 'result', { value: fakeCryptoDatabase(cleared) });
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
  };
  if (existing !== null) {
    factory.databases = () => Promise.resolve(existing.map((name) => ({ name })));
  }
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', { bound: (lower: string, upper: string) => ({ lower, upper }) });
  return { deleted, cleared };
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

test('removes the rebuildable stores but keeps the session and the crypto stores', async () => {
  const { deleted } = stubIndexedDB([
    'sable-next-session',
    'sable-next-account-a1',
    'sable-next-account-a1::matrix-sdk-state',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
    'sable-next-account-a1::matrix-sdk-crypto',
    'sable-next-account-a1::matrix-sdk-crypto-meta',
    'unrelated-database',
  ]);

  await resetWebStorage();

  expect(deleted).toEqual([
    'sable-next-account-a1',
    'sable-next-account-a1::matrix-sdk-state',
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
    'sable-next::matrix-sdk-state',
    'sable-next::event_cache',
    'sable-next::media',
    'sable-next-account-a1',
    'sable-next-account-a1::matrix-sdk-state',
    'sable-next-account-a1::event_cache',
    'sable-next-account-a1::media',
  ]);
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
    'sable-next-account-a1::matrix-sdk-crypto',
    'sable-next-account-a1::matrix-sdk-crypto-meta',
  ]);
});
