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

export interface PushContentPolicy {
  content: boolean;
  encryptedContent: boolean;
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
    };
  } catch {
    return { content: false, encryptedContent: false };
  }
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
