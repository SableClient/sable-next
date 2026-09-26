import type { NotificationModeView } from '#src/generated/protocol';

import { appendPushEntry, type PushHistoryEntry, readPushHistory } from './push-history';

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

export async function putRoomNames(names: ReadonlyMap<string, string>): Promise<void> {
  await putAll(names);
}

async function putAll(entries: Iterable<readonly [string, string]>): Promise<void> {
  const database = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const [key, value] of entries) store.put(value, key);
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

const MODE_PREFIX = '\u0000mode:';

export async function putRoomModes(modes: ReadonlyMap<string, string>): Promise<void> {
  await putAll([...modes].map(([roomId, mode]) => [MODE_PREFIX + roomId, mode] as const));
}

export async function roomMode(roomId: string): Promise<NotificationModeView | null> {
  try {
    const stored = await transact<unknown>('readonly', (store) => store.get(MODE_PREFIX + roomId));
    return stored === 'all' || stored === 'mentions' || stored === 'mute' ? stored : null;
  } catch {
    return null;
  }
}

export interface PushContentPolicy {
  content: boolean;
  encryptedContent: boolean;
  notifyOnce: boolean;
}

const POLICY_KEY = '\u0000push-content-policy';

export async function putPushContentPolicy(policy: PushContentPolicy): Promise<void> {
  try {
    await transact('readwrite', (store) => store.put(policy, POLICY_KEY));
  } catch {
    return;
  }
}

export async function pushContentPolicy(): Promise<PushContentPolicy> {
  try {
    const stored = (await transact<unknown>('readonly', (store) => store.get(POLICY_KEY))) as
      | Partial<PushContentPolicy>
      | undefined;
    return {
      content: stored?.content === true,
      encryptedContent: stored?.encryptedContent === true,
      notifyOnce: stored?.notifyOnce === true,
    };
  } catch {
    return { content: false, encryptedContent: false, notifyOnce: false };
  }
}

export interface PushSession {
  userId: string;
  homeserver: string;
  accessToken: string;
}

const SESSION_PREFIX = '\u0000session:';

export async function putPushSession(session: PushSession): Promise<void> {
  try {
    await transact('readwrite', (store) => store.put(session, SESSION_PREFIX + session.userId));
  } catch {
    return;
  }
}

export async function forgetPushSession(userId: string): Promise<void> {
  try {
    await transact('readwrite', (store) => store.delete(SESSION_PREFIX + userId));
  } catch {
    return;
  }
}

export async function forgetPushSessions(): Promise<void> {
  try {
    await transact('readwrite', (store) =>
      store.delete(IDBKeyRange.bound(SESSION_PREFIX, `${SESSION_PREFIX}\uffff`))
    );
  } catch {
    return;
  }
}

export async function pushSession(userId: string | undefined): Promise<PushSession | null> {
  try {
    const stored = await transact<unknown[]>('readonly', (store) =>
      userId === undefined
        ? store.getAll(IDBKeyRange.bound(SESSION_PREFIX, `${SESSION_PREFIX}\uffff`), 2)
        : store.getAll(SESSION_PREFIX + userId)
    );
    return stored.length === 1 ? readPushSession(stored[0]) : null;
  } catch {
    return null;
  }
}

function readPushSession(value: unknown): PushSession | null {
  const session = value as Partial<PushSession> | undefined;
  return typeof session?.userId === 'string' &&
    typeof session.homeserver === 'string' &&
    typeof session.accessToken === 'string'
    ? { userId: session.userId, homeserver: session.homeserver, accessToken: session.accessToken }
    : null;
}

export type RoomNameSink = (names: ReadonlyMap<string, string>) => Promise<void>;

const WRITE_DELAY_MS = 1000;

export class RoomNameWriter {
  readonly #written = new Map<string, string>();
  readonly #pending = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly write: RoomNameSink = putRoomNames,
    private readonly delayMs: number = WRITE_DELAY_MS
  ) {}

  remember(names: ReadonlyMap<string, string>): void {
    for (const [roomId, name] of names) {
      if (this.#written.get(roomId) !== name) this.#pending.set(roomId, name);
    }
    if (this.#pending.size === 0 || this.#timer !== undefined) return;

    this.#timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#pending.size === 0) return;

    const batch = new Map(this.#pending);
    this.#pending.clear();
    try {
      await this.write(batch);
      for (const [roomId, name] of batch) this.#written.set(roomId, name);
    } catch {
      for (const [roomId, name] of batch) {
        if (!this.#pending.has(roomId)) this.#pending.set(roomId, name);
      }
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

const HISTORY_KEY = '\u0000push-history';

export async function recordPush(entry: PushHistoryEntry): Promise<void> {
  try {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const read = store.get(HISTORY_KEY);
      read.onsuccess = () => {
        store.put(appendPushEntry(readPushHistory(read.result), entry), HISTORY_KEY);
      };
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('push history unavailable'));
      };
    });
  } catch {
    return;
  }
}

export async function pushHistory(): Promise<PushHistoryEntry[]> {
  try {
    return readPushHistory(await transact<unknown>('readonly', (store) => store.get(HISTORY_KEY)));
  } catch {
    return [];
  }
}

export async function clearPushHistory(): Promise<void> {
  await transact('readwrite', (store) => store.delete(HISTORY_KEY));
}
