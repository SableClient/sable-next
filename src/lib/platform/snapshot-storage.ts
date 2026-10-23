import { openDB, type IDBPDatabase } from 'idb';

const STORE_NAME = 'snapshots';
const APP_DATABASE = 'sable-next';
const databases = new Map<string, Promise<IDBPDatabase>>();

function database(key: string): Promise<IDBPDatabase> {
  const account = key.split('/')[1];
  const name = `${account ? `${APP_DATABASE}-account-${account}` : APP_DATABASE}::snapshots`;
  let opened = databases.get(name);
  if (!opened) {
    opened = openDB(name, 1, {
      upgrade: (db) => {
        db.createObjectStore(STORE_NAME);
      },
      blocking: () => {
        void opened?.then((db) => {
          db.close();
        });
        databases.delete(name);
      },
      terminated: () => {
        databases.delete(name);
      },
    });
    databases.set(name, opened);
  }
  return opened;
}

export async function loadSnapshot(key: string): Promise<string | null> {
  const stored: unknown = await (await database(key)).get(STORE_NAME, key);
  return typeof stored === 'string' ? stored : null;
}

export async function saveSnapshot(key: string, value: string): Promise<void> {
  await (await database(key)).put(STORE_NAME, value, key);
}
