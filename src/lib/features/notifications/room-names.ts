/** A service worker has no session to ask for a room's name, so the app leaves
    the names where it can read them. */
const DATABASE = 'sable-notifications';
const STORE = 'room-names';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('room names unavailable'));
    };
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return open().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const request = run(database.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('room names unavailable'));
        };
      })
  );
}

export async function rememberRoomNames(names: ReadonlyMap<string, string>): Promise<void> {
  const database = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const [roomId, name] of names) store.put(name, roomId);
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('room names unavailable'));
    };
  });
}

export async function roomName(roomId: string): Promise<string | null> {
  try {
    return (await transact<unknown>('readonly', (store) => store.get(roomId))) as string | null;
  } catch {
    return null;
  }
}
