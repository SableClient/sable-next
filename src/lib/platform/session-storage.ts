const DATABASE_NAME = 'sable-next-session';
const DATABASE_VERSION = 1;
const STORE_NAME = 'session';
const SESSION_KEY = 'current';

const APP_DATABASE_PREFIX = 'sable-next';
const KNOWN_DATABASE_NAMES = [
  'sable-next',
  'sable-next::matrix-sdk-state',
  'sable-next::matrix-sdk-crypto',
  'sable-next::matrix-sdk-crypto-meta',
  'sable-next::event_cache',
  'sable-next::media',
];

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

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Could not delete ${name}`));
    };
    request.onblocked = () => {
      reject(new Error(`Could not delete ${name}: database is still open`));
    };
  });
}

async function appDatabaseNames(): Promise<string[]> {
  if (typeof globalThis.indexedDB.databases !== 'function') {
    return [DATABASE_NAME, ...KNOWN_DATABASE_NAMES];
  }

  try {
    const listed = await globalThis.indexedDB.databases();
    const owned = listed
      .map((database) => database.name)
      .filter((name): name is string => name?.startsWith(APP_DATABASE_PREFIX) ?? false);

    return [DATABASE_NAME, ...owned];
  } catch {
    return [DATABASE_NAME, ...KNOWN_DATABASE_NAMES];
  }
}

async function clearHttpCaches(): Promise<void> {
  const storage = 'caches' in globalThis ? globalThis.caches : undefined;
  if (!storage) return;

  const names = await storage.keys();
  await Promise.all(names.map((name) => storage.delete(name)));
}

export async function resetWebStorage(): Promise<void> {
  const database = await databasePromise?.catch(() => undefined);
  database?.close();
  databasePromise = undefined;

  const names = await appDatabaseNames();
  await Promise.all([...new Set(names)].map(deleteDatabase));
  await clearHttpCaches();
}
