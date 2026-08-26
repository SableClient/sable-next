import { afterEach, expect, test, vi } from 'vitest';

import { resetWebSession } from './session-storage.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('removes the app session and every Matrix SDK IndexedDB store', async () => {
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

  await resetWebSession();

  expect(deleted).toEqual([
    'sable-next-session',
    'sable-next',
    'sable-next::matrix-sdk-state',
    'sable-next::matrix-sdk-crypto',
    'sable-next::matrix-sdk-crypto-meta',
    'sable-next::event_cache',
    'sable-next::media',
  ]);
});
