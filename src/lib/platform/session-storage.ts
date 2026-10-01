const DATABASE_NAME = 'sable-next-session';
const DATABASE_VERSION = 1;
const STORE_NAME = 'session';
const SESSION_KEY = 'current';
const V1_MIGRATION_KEY = 'v1-migrated';

const APP_DATABASE_PREFIX = 'sable-next';
const ACCOUNT_STORE_INFIX = '-account-';
const CACHE_DATABASE_SUFFIXES = ['', '::matrix-sdk-state', '::event_cache', '::media'];
const SEARCH_DATABASE_SUFFIX = '::sable-search';
const STATE_DATABASE_SUFFIX = '::matrix-sdk-state';
const SEARCH_KEY_PREFIX = 'sable.search.';
const LEGACY_SEARCH_KEY_PREFIX = `${SEARCH_KEY_PREFIX}documents.`;
const SEARCH_ROOMS_KEY = `${SEARCH_KEY_PREFIX}rooms`;
const CRYPTO_DATABASE_SUFFIX = '::matrix-sdk-crypto';
const CRYPTO_META_DATABASE_SUFFIX = '::matrix-sdk-crypto-meta';
const CRYPTO_CORE_STORE = 'core';
const SLIDING_SYNC_KEY_PREFIX = 'sliding_sync_store::';

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Could not open the session database'));
    };
  });

  return databasePromise;
}

function transaction(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest
): Promise<void> {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, mode);
        const request = operation(tx.objectStore(STORE_NAME));

        request.onerror = () => {
          reject(request.error ?? new Error('Session database request failed'));
        };
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error('Session database transaction failed'));
        };
        tx.onabort = () => {
          reject(tx.error ?? new Error('Session database transaction aborted'));
        };
      })
  );
}

function toBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError('Session database returned an unsupported value');
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function loadSession(): Promise<Uint8Array | null> {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(SESSION_KEY);

        request.onsuccess = () => {
          try {
            resolve(toBytes(request.result));
          } catch (error) {
            reject(asError(error));
          }
        };
        request.onerror = () => {
          reject(request.error ?? new Error('Could not load the session'));
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error('Could not read the session database'));
        };
      })
  );
}

export function saveSession(bytes: Uint8Array): Promise<void> {
  // Copy the WASM-owned bytes before IndexedDB takes ownership of the value.
  const value = Uint8Array.from(bytes).buffer;
  return transaction('readwrite', (store) => store.put(value, SESSION_KEY));
}

export function clearSession(): Promise<void> {
  return transaction('readwrite', (store) => store.delete(SESSION_KEY));
}

export async function v1MigrationComplete(): Promise<boolean> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(V1_MIGRATION_KEY);
    tx.oncomplete = () => {
      resolve(request.result === true);
    };
    tx.onabort = tx.onerror = () => {
      reject(tx.error ?? new Error('Could not read migration status'));
    };
  });
}

export function markV1MigrationComplete(): Promise<void> {
  return transaction('readwrite', (store) => store.put(true, V1_MIGRATION_KEY));
}

export async function saveV1Session(bytes: Uint8Array): Promise<void> {
  const database = await openDatabase();
  const value = Uint8Array.from(bytes).buffer;
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(value, SESSION_KEY);
    store.put(true, V1_MIGRATION_KEY);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      reject(tx.error ?? new Error('Could not save the migrated accounts'));
    };
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Could not delete ${name}`));
    };
  });
}

function storeIds(accountIds: readonly string[]): string[] {
  return [
    APP_DATABASE_PREFIX,
    ...accountIds.map((id) => `${APP_DATABASE_PREFIX}${ACCOUNT_STORE_INFIX}${id}`),
  ];
}

function derivedNames(ids: readonly string[], suffixes: readonly string[]): string[] {
  return ids.flatMap((id) => suffixes.map((suffix) => `${id}${suffix}`));
}

function isAppDatabase(name: string | undefined): name is string {
  return name !== undefined && name.startsWith(APP_DATABASE_PREFIX) && name !== DATABASE_NAME;
}

async function listedDatabaseNames(): Promise<string[] | null> {
  if (typeof globalThis.indexedDB.databases !== 'function') return null;

  try {
    const listed = await globalThis.indexedDB.databases();
    return listed.map((database) => database.name).filter(isAppDatabase);
  } catch {
    return null;
  }
}

function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(name);

    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      if (request.error?.name === 'AbortError') {
        resolve(null);
        return;
      }
      reject(request.error ?? new Error(`Could not open ${name}`));
    };
  });
}

async function clearSlidingSyncPosition(name: string): Promise<void> {
  const database = await openExistingDatabase(name);
  if (!database) return;

  try {
    if (!database.objectStoreNames.contains(CRYPTO_CORE_STORE)) return;

    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(CRYPTO_CORE_STORE, 'readwrite');
      tx.objectStore(CRYPTO_CORE_STORE).delete(
        IDBKeyRange.bound(SLIDING_SYNC_KEY_PREFIX, `${SLIDING_SYNC_KEY_PREFIX}\uffff`)
      );
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error(`Could not clear the sliding sync position in ${name}`));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error(`Could not clear the sliding sync position in ${name}`));
      };
    });
  } finally {
    database.close();
  }
}

async function clearHttpCaches(): Promise<void> {
  const storage = 'caches' in globalThis ? globalThis.caches : undefined;
  if (!storage) return;

  const names = await storage.keys();
  await Promise.all(names.map((name) => storage.delete(name)));
}

async function clearStateCache(name: string): Promise<void> {
  const database = await openExistingDatabase(name);
  if (!database) return;

  try {
    const stores = Array.from(database.objectStoreNames);
    if (stores.length === 0) return;
    const rooms = database.objectStoreNames.contains('custom')
      ? await listLegacySearchRooms(database)
      : undefined;
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(stores, 'readwrite');
      for (const name of stores) {
        const store = tx.objectStore(name);
        if (name === 'custom') {
          if (rooms) store.put(rooms, SEARCH_ROOMS_KEY);
          store.delete(IDBKeyRange.upperBound(SEARCH_KEY_PREFIX, true));
          store.delete(IDBKeyRange.lowerBound(`${SEARCH_KEY_PREFIX}\uffff`, true));
        } else {
          store.clear();
        }
      }
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error(`Could not reset ${name}`));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error(`Could not reset ${name}`));
      };
    });
  } finally {
    database.close();
  }
}

async function listLegacySearchRooms(database: IDBDatabase): Promise<number[] | undefined> {
  const stored = await new Promise<{ keys: IDBValidKey[]; rooms: number[] | undefined }>(
    (resolve, reject) => {
      const tx = database.transaction('custom', 'readonly');
      const store = tx.objectStore('custom');
      const keys = store.getAllKeys(
        IDBKeyRange.bound(LEGACY_SEARCH_KEY_PREFIX, `${LEGACY_SEARCH_KEY_PREFIX}\uffff`)
      );
      const rooms = store.get(SEARCH_ROOMS_KEY);
      tx.oncomplete = () => {
        resolve({ keys: keys.result, rooms: rooms.result as number[] | undefined });
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('Could not read the search rooms'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('Could not read the search rooms'));
      };
    }
  );
  if (stored.keys.length === 0) return undefined;
  const bytes = stored.rooms ? Uint8Array.from(stored.rooms) : undefined;
  const rooms = bytes
    ? (JSON.parse(
        new TextDecoder().decode(bytes[0] === 0x78 ? unzlibSync(bytes) : bytes)
      ) as string[])
    : [];
  const listed = new Set(rooms);
  for (const key of stored.keys) {
    if (typeof key === 'string') listed.add(key.slice(LEGACY_SEARCH_KEY_PREFIX.length));
  }
  if (listed.size === rooms.length) return undefined;
  return Array.from(new TextEncoder().encode(JSON.stringify([...listed])));
}

function rejections(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter((result) => result.status === 'rejected')
    .map((result): unknown => result.reason);
}

export async function deleteAccountWebStorage(accountId: string): Promise<void> {
  const prefix = `${APP_DATABASE_PREFIX}${ACCOUNT_STORE_INFIX}${accountId}`;
  const listed = await listedDatabaseNames();
  const names = listed
    ? listed.filter((name) => name === prefix || name.startsWith(`${prefix}::`))
    : derivedNames(
        [prefix],
        [
          ...CACHE_DATABASE_SUFFIXES,
          SEARCH_DATABASE_SUFFIX,
          CRYPTO_DATABASE_SUFFIX,
          CRYPTO_META_DATABASE_SUFFIX,
        ]
      );

  const failures = rejections(await Promise.allSettled([...new Set(names)].map(deleteDatabase)));

  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not delete the local store for ${accountId}`);
  }
}

export async function resetWebStorage(accountIds: readonly string[] = []): Promise<void> {
  const ids = storeIds(accountIds);
  const listed = await listedDatabaseNames();
  const crypto = listed
    ? listed.filter((name) => name.endsWith(CRYPTO_DATABASE_SUFFIX))
    : derivedNames(ids, [CRYPTO_DATABASE_SUFFIX]);
  const caches = listed
    ? listed.filter(
        (name) => !name.includes(CRYPTO_DATABASE_SUFFIX) && !name.endsWith(SEARCH_DATABASE_SUFFIX)
      )
    : derivedNames(ids, CACHE_DATABASE_SUFFIXES);

  const failures = [
    ...rejections(await Promise.allSettled([...new Set(crypto)].map(clearSlidingSyncPosition))),
    ...rejections(
      await Promise.allSettled(
        [...new Set(caches)].map((name) =>
          name.endsWith(STATE_DATABASE_SUFFIX) ? clearStateCache(name) : deleteDatabase(name)
        )
      )
    ),
    ...rejections(await Promise.allSettled([clearHttpCaches()])),
  ];

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not fully reset the local caches');
  }
}
import { unzlibSync } from 'fflate';
