import { expect, test, vi } from 'vitest';

import { loadSession, saveSession } from './session-storage.js';

function rawSession(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('sable-next-session', 1);
    open.onerror = () => {
      reject(open.error ?? new Error('could not open'));
    };
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction('session').objectStore('session').get('current');
      request.onsuccess = () => {
        database.close();
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('could not read'));
      };
    };
  });
}

test('a browser that cannot store the key keeps the session unsealed', async () => {
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (args[0] instanceof CryptoKey) throw new DOMException('cannot clone', 'DataCloneError');
    return IDBObjectStore.prototype.put.apply(this, args);
  });
  const registry = new TextEncoder().encode('{"access_token":"secret-token"}');

  await saveSession(registry);

  expect(await rawSession()).toEqual(registry);
  await expect(loadSession()).resolves.toEqual(registry);
});
