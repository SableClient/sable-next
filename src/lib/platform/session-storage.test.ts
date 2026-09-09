import { afterEach, expect, test, vi } from 'vitest';

import { resetWebStorage } from './session-storage.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubIndexedDB(existing: string[]) {
  const deleted: string[] = [];
  vi.stubGlobal('indexedDB', {
    databases: () => Promise.resolve(existing.map((name) => ({ name }))),
    deleteDatabase(name: string) {
      deleted.push(name);
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
  });
  return deleted;
}

test('removes the rebuildable stores but keeps the session and the crypto stores', async () => {
  const deleted = stubIndexedDB([
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

test('uses known database names when database listing is unavailable', async () => {
  const deleted: string[] = [];
  vi.stubGlobal('indexedDB', {
    deleteDatabase(name: string) {
      deleted.push(name);
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
  });

  await resetWebStorage();

  expect(deleted).toEqual([
    'sable-next',
    'sable-next::matrix-sdk-state',
    'sable-next::event_cache',
    'sable-next::media',
  ]);
});
