const STORE_NAME = 'snapshots';
const APP_DATABASE = 'sable-next';

const databases = new Map<string, Promise<IDBDatabase>>();

/** A database per account, named so that deleting the account's local store deletes its snapshots. */
function databaseName(key: string): string {
  const account = key.split('/')[1];
  return `${account ? `${APP_DATABASE}-account-${account}` : APP_DATABASE}::snapshots`;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Snapshot database request failed'));
    };
  });
}

function open(name: string): Promise<IDBDatabase> {
  let database = databases.get(name);
  if (!database) {
    const request = globalThis.indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    database = settled(request).then((opened) => {
      opened.onversionchange = () => {
        opened.close();
        databases.delete(name);
      };
      return opened;
    });
    databases.set(name, database);
  }
  return database;
}

export async function loadSnapshot(key: string): Promise<string | null> {
  const database = await open(databaseName(key));
  const stored = await settled<unknown>(
    database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key)
  );
  return typeof stored === 'string' ? stored : null;
}

export async function saveSnapshot(key: string, value: string): Promise<void> {
  const database = await open(databaseName(key));
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await settled(transaction.objectStore(STORE_NAME).put(value, key));
}
