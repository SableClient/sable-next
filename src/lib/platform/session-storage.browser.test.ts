import { beforeEach, expect, test } from 'vitest';

import { loadSession, saveSession } from './session-storage.js';

const DATABASE = 'sable-next-session';

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error('could not delete'));
    };
  });
}

function rawRecord(key: string, value?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('session');
    };
    open.onerror = () => {
      reject(open.error ?? new Error('could not open'));
    };
    open.onsuccess = () => {
      const database = open.result;
      const tx = database.transaction('session', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('session');
      const request = value === undefined ? store.get(key) : store.put(value, key);
      tx.oncomplete = () => {
        database.close();
        resolve(value === undefined ? request.result : undefined);
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('could not access'));
      };
    };
  });
}

const registry = new TextEncoder().encode('{"access_token":"secret-token"}');

beforeEach(async () => {
  await deleteDatabase();
});

test('a saved session is sealed and reads back', async () => {
  await saveSession(registry);

  const stored = (await rawRecord('current')) as { iv: unknown; data: unknown };
  expect(stored.iv).toBeInstanceOf(Uint8Array);
  expect(stored.data).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(stored.data as ArrayBuffer)).not.toContain('secret-token');
  await expect(loadSession()).resolves.toEqual(registry);
});

test('a session saved before sealing is sealed on first read', async () => {
  await rawRecord('current', registry.slice().buffer);

  await expect(loadSession()).resolves.toEqual(registry);
  expect(((await rawRecord('current')) as { iv: unknown }).iv).toBeInstanceOf(Uint8Array);
});

test('a sealed session that no longer opens reads as signed out', async () => {
  await saveSession(registry);
  const stored = (await rawRecord('current')) as { iv: Uint8Array };
  await rawRecord('current', { iv: stored.iv, data: new ArrayBuffer(48) });

  await expect(loadSession()).resolves.toBeNull();
});
