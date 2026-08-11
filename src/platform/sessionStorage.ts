const DATABASE_NAME = 'sable-next-session';
const DATABASE_VERSION = 1;
const STORE_NAME = 'session';
const SESSION_KEY = 'current';

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
