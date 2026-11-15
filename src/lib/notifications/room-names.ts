import type { NotificationModeView } from '#src/generated/protocol';
import { bindServerNotificationOwner } from '#lib/platform/server-notification-owner.js';

import { appendPushEntry, type PushHistoryEntry, readPushHistory } from './push-history';

/** A service worker has no session to ask for a room's name, so the app leaves
    the names where it can read them. */
const DATABASE = 'sable-notifications';
const STORE = 'room-names';

const TELEMETRY_KEY = '\u0000telemetry-consent';

export async function putTelemetryConsent(enabled: boolean): Promise<void> {
  const database = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(enabled, TELEMETRY_KEY);
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        reject(transaction.error ?? new Error('telemetry consent unavailable'));
      };
    });
  } finally {
    database.close();
  }
}

export async function telemetryConsent(): Promise<boolean> {
  try {
    const database = await open();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = database
          .transaction(STORE, 'readonly')
          .objectStore(STORE)
          .get(TELEMETRY_KEY);
        request.onsuccess = () => {
          resolve(request.result === true);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('telemetry consent unavailable'));
        };
      });
    } finally {
      database.close();
    }
  } catch (error) {
    console.debug('[sable notifications] telemetry consent unreadable', error);
    return false;
  }
}

let boundServerUser: string | null = null;

export class ServerSessionError extends Error {
  constructor(readonly status: number) {
    super(`server session unavailable (${status})`);
    this.name = 'ServerSessionError';
  }
}

export class ServerIdentityChangedError extends Error {
  constructor() {
    super('server identity changed');
    this.name = 'ServerIdentityChangedError';
  }
}

export function isServerAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof ServerIdentityChangedError ||
    (error instanceof ServerSessionError && (error.status === 401 || error.status === 403))
  );
}

export function boundServerIdentity(): string | null {
  return boundServerUser;
}

export async function bindServerNotificationIdentity(): Promise<void> {
  if (!import.meta.env.VITE_SABLE_SERVER_URL) return;
  const current = await currentServerUser();
  if (boundServerUser !== null && boundServerUser !== current) {
    throw new ServerIdentityChangedError();
  }
  if ('document' in globalThis) {
    await clearPushSessionsInDatabase(DATABASE);
    await bindServerNotificationOwner(current, clearServerPushSessions);
  }
  boundServerUser = current;
}

export async function currentServerUser(): Promise<string> {
  const base = new URL(import.meta.env.VITE_SABLE_SERVER_URL ?? '/', globalThis.location.href);
  const response = await fetch(new URL('/_sable/identity', base), {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new ServerSessionError(response.status);
  const identity: unknown = await response.json();
  if (
    typeof identity !== 'object' ||
    identity === null ||
    !('id' in identity) ||
    typeof identity.id !== 'string' ||
    !/^(legacy|[0-9a-f-]{36})$/.test(identity.id)
  ) {
    throw new Error('invalid server identity');
  }
  return identity.id;
}

async function open(): Promise<IDBDatabase> {
  let databaseName = DATABASE;
  if (import.meta.env.VITE_SABLE_SERVER_URL) {
    const id = await currentServerUser();
    if ('document' in globalThis && (boundServerUser === null || boundServerUser !== id)) {
      throw new Error('server identity changed');
    }
    databaseName += `-${id}`;
  }
  return openDatabase(databaseName);
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
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
    const stored = await transact<unknown>('readonly', (store) => store.get(roomId));
    return typeof stored === 'string' ? stored : null;
  } catch (error) {
    console.debug('[sable notifications] room name unreadable', error);
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
  } catch (error) {
    console.debug('[sable notifications] room mode unreadable', error);
    return null;
  }
}

export interface PushContentPolicy {
  content: boolean;
  encryptedContent: boolean;
  notifyOnce: boolean;
  clearOnRead: boolean;
  quietWhenActiveElsewhere: boolean;
  inAppBanners: boolean;
}

const POLICY_KEY = '\u0000push-content-policy';

export async function putPushContentPolicy(policy: PushContentPolicy): Promise<void> {
  try {
    await transact('readwrite', (store) => store.put(policy, POLICY_KEY));
  } catch (error) {
    console.debug('[sable notifications] push content policy not stored', error);
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
      clearOnRead: stored?.clearOnRead !== false,
      quietWhenActiveElsewhere: stored?.quietWhenActiveElsewhere === true,
      inAppBanners: stored?.inAppBanners === true,
    };
  } catch (error) {
    console.debug('[sable notifications] push content policy unreadable', error);
    return {
      content: false,
      encryptedContent: false,
      notifyOnce: false,
      clearOnRead: true,
      quietWhenActiveElsewhere: false,
      inAppBanners: false,
    };
  }
}

export interface PushSession {
  userId: string;
  deviceId?: string;
  homeserver: string;
  accessToken: string;
}

const SESSION_PREFIX = '\u0000session:';

/** Remove browser-held Matrix tokens when a server user leaves this profile. */
export async function clearServerPushSessions(serverUserId: string): Promise<void> {
  if (!/^(legacy|[0-9a-f-]{36})$/.test(serverUserId)) throw new Error('invalid server identity');
  await Promise.all([
    clearPushSessionsInDatabase(DATABASE),
    clearPushSessionsInDatabase(`${DATABASE}-${serverUserId}`),
  ]);
}

async function clearPushSessionsInDatabase(name: string): Promise<void> {
  const database = await openDatabase(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction
        .objectStore(STORE)
        .delete(IDBKeyRange.bound(SESSION_PREFIX, `${SESSION_PREFIX}\uffff`));
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        reject(transaction.error ?? new Error('push sessions unavailable'));
      };
    });
  } finally {
    database.close();
  }
}

export async function putPushSession(session: PushSession): Promise<void> {
  try {
    await transact('readwrite', (store) => store.put(session, SESSION_PREFIX + session.userId));
  } catch (error) {
    console.debug('[sable notifications] push session not stored', error);
  }
}

export async function forgetPushSession(userId: string): Promise<void> {
  try {
    await transact('readwrite', (store) => store.delete(SESSION_PREFIX + userId));
  } catch (error) {
    console.debug('[sable notifications] push session not forgotten', error);
  }
}

export async function forgetPushSessions(): Promise<void> {
  try {
    await transact('readwrite', (store) =>
      store.delete(IDBKeyRange.bound(SESSION_PREFIX, `${SESSION_PREFIX}\uffff`))
    );
  } catch (error) {
    console.debug('[sable notifications] push sessions not forgotten', error);
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
  } catch (error) {
    console.debug('[sable notifications] push session unreadable', error);
    return null;
  }
}

/** MSC4174 expires an ack token after five minutes. */
export const PUSH_ACTIVATION_TTL_MS = 5 * 60 * 1000;

const ACTIVATION_PREFIX = '\u0000webpush-activation:';

export async function expectPushActivation(userId: string): Promise<void> {
  try {
    await transact('readwrite', (store) =>
      store.put({ userId, at: Date.now() }, ACTIVATION_PREFIX + userId)
    );
  } catch (error) {
    console.debug('[sable notifications] push activation not noted', error);
  }
}

export async function settlePushActivation(userId: string): Promise<void> {
  try {
    await transact('readwrite', (store) => store.delete(ACTIVATION_PREFIX + userId));
  } catch (error) {
    console.debug('[sable notifications] push activation not settled', error);
  }
}

export async function pendingPushActivations(now: number): Promise<string[]> {
  try {
    const stored = await transact<unknown[]>('readonly', (store) =>
      store.getAll(IDBKeyRange.bound(ACTIVATION_PREFIX, `${ACTIVATION_PREFIX}\uffff`))
    );
    return stored.flatMap((value) => {
      const pending = value as { userId?: unknown; at?: unknown } | undefined;
      return typeof pending?.userId === 'string' &&
        typeof pending.at === 'number' &&
        now - pending.at < PUSH_ACTIVATION_TTL_MS
        ? [pending.userId]
        : [];
    });
  } catch (error) {
    console.debug('[sable notifications] push activations unreadable', error);
    return [];
  }
}

function readPushSession(value: unknown): PushSession | null {
  const session = value as Partial<PushSession> | undefined;
  return typeof session?.userId === 'string' &&
    typeof session.homeserver === 'string' &&
    typeof session.accessToken === 'string'
    ? {
        userId: session.userId,
        ...(typeof session.deviceId === 'string' ? { deviceId: session.deviceId } : {}),
        homeserver: session.homeserver,
        accessToken: session.accessToken,
      }
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
    } catch (error) {
      console.debug('[sable notifications] room names not stored', error);
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
  } catch (error) {
    console.debug('[sable notifications] push history not recorded', error);
  }
}

export async function pushHistory(): Promise<PushHistoryEntry[]> {
  try {
    return readPushHistory(await transact<unknown>('readonly', (store) => store.get(HISTORY_KEY)));
  } catch (error) {
    console.debug('[sable notifications] push history unreadable', error);
    return [];
  }
}

export async function clearPushHistory(): Promise<void> {
  await transact('readwrite', (store) => store.delete(HISTORY_KEY));
}
