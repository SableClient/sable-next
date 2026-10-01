import { V1_MIGRATION_ENABLED, V1MigrationError } from './config.js';
export { V1MigrationError } from './config.js';
import {
  loadSession,
  saveV1Session,
  v1MigrationComplete,
  markV1MigrationComplete,
} from '#lib/platform/session-storage.js';

export interface V1Session {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  fallbackSdkStores?: boolean;
  oidc?: { issuer: string; clientId: string };
}

export interface LegacyEntry {
  key: IDBValidKey;
  value: unknown;
}

const BATCH_SIZE = 128;
let pending: Promise<void> | undefined;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readV1Sessions(storage: Storage): V1Session[] {
  const raw = storage.getItem('matrixSessions');
  let parsed: unknown;
  try {
    parsed = raw === null ? [] : JSON.parse(raw);
  } catch {
    throw new Error('The v1 account list is invalid; its data has been kept');
  }
  if (!Array.isArray(parsed)) throw new Error('The v1 account list is invalid');
  const fallback = {
    baseUrl: storage.getItem('cinny_hs_base_url'),
    userId: storage.getItem('cinny_user_id'),
    deviceId: storage.getItem('cinny_device_id'),
    accessToken: storage.getItem('cinny_access_token'),
    fallbackSdkStores: true,
  };
  if (Object.values(fallback).some((value) => typeof value === 'string')) parsed.push(fallback);
  const sessions: V1Session[] = [];
  for (const value of parsed) {
    if (
      !record(value) ||
      !['baseUrl', 'userId', 'deviceId', 'accessToken'].every(
        (key) => typeof value[key] === 'string' && value[key].length > 0
      ) ||
      (value.refreshToken !== undefined && typeof value.refreshToken !== 'string') ||
      (value.oidc !== undefined &&
        (!record(value.oidc) ||
          typeof value.oidc.issuer !== 'string' ||
          typeof value.oidc.clientId !== 'string' ||
          !value.oidc.issuer ||
          !value.oidc.clientId))
    ) {
      throw new Error('A v1 account is incomplete; its data has been kept');
    }
    const url = new URL(value.baseUrl as string);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid v1 homeserver');
    const session = value as unknown as V1Session;
    if (session.oidc) {
      const issuer = new URL(session.oidc.issuer);
      if (issuer.protocol !== 'https:' || issuer.username || issuer.password)
        throw new Error('Invalid v1 OAuth issuer');
    }
    if (
      !sessions.some(
        (other) => other.userId === session.userId && other.deviceId === session.deviceId
      )
    ) {
      sessions.push(session);
    }
  }
  return sessions;
}

export function v1CryptoPrefixes(session: V1Session): string[] {
  const prefix = session.fallbackSdkStores ? 'matrix-js-sdk' : `sync${session.userId}`;
  return [`${prefix}:${session.deviceId}`, prefix];
}

export function openV1Database(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let absent = false;
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      if (absent) resolve(null);
      else reject(request.error ?? new Error('Could not read v1 storage'));
    };
    request.onblocked = () => {
      reject(new Error('Close the other Sable windows to migrate v1 data'));
    };
  });
}

function readValue(database: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(key);
    tx.oncomplete = () => {
      resolve(request.result as unknown);
    };
    tx.onabort = tx.onerror = () => {
      reject(tx.error ?? new Error('Could not read v1 crypto'));
    };
  });
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    if (value.startsWith('{')) return JSON.parse(value) as unknown;
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('A v1 encryption record is invalid; its data has been kept');
  }
}

async function findCrypto(session: V1Session): Promise<IDBDatabase | null> {
  for (const prefix of v1CryptoPrefixes(session)) {
    const database = await openV1Database(`${prefix}::matrix-sdk-crypto`);
    if (!database) continue;
    let matched = false;
    try {
      if (!database.objectStoreNames.contains('core')) continue;
      const account = decode(await readValue(database, 'core', 'account'));
      if (
        record(account) &&
        account.user_id === session.userId &&
        account.device_id === session.deviceId
      ) {
        matched = true;
        return database;
      }
      if (record(account) && 'ciphertext' in account) {
        throw new Error('The v1 crypto store needs its encryption key; its data has been kept');
      }
    } finally {
      if (!matched) database.close();
    }
  }
  return null;
}

export function readV1Batch(
  database: IDBDatabase,
  store: string,
  after?: IDBValidKey
): Promise<LegacyEntry[]> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readonly');
    const entries: LegacyEntry[] = [];
    const request = tx
      .objectStore(store)
      .openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      entries.push({ key: cursor.key, value: cursor.value as unknown });
      if (entries.length < BATCH_SIZE) cursor.continue();
    };
    tx.oncomplete = () => {
      resolve(entries);
    };
    tx.onabort = tx.onerror = () => {
      reject(tx.error ?? new Error('Could not read v1 crypto'));
    };
  });
}

async function eachBatch(
  database: IDBDatabase,
  consume: (store: string, entries: LegacyEntry[]) => Promise<void>
): Promise<void> {
  const stores = Array.from(database.objectStoreNames);
  stores.sort((a, b) => Number(b === 'core') - Number(a === 'core'));
  for (const store of stores) {
    let after: IDBValidKey | undefined;
    for (;;) {
      const entries = await readV1Batch(database, store, after);
      if (entries.length === 0) break;
      await consume(store, entries);
      after = entries.at(-1)?.key;
    }
  }
}

async function copyDatabase(source: IDBDatabase, name: string): Promise<void> {
  const counts = await storeCounts(source);
  const account = source.objectStoreNames.contains('core')
    ? JSON.stringify(await readValue(source, 'core', 'account'))
    : undefined;
  const destination = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, source.version);
    request.onupgradeneeded = () => {
      for (const name of Array.from(source.objectStoreNames)) {
        const original = source.transaction(name).objectStore(name);
        const store = request.result.createObjectStore(name, {
          keyPath: original.keyPath,
          autoIncrement: original.autoIncrement,
        });
        for (const name of Array.from(original.indexNames)) {
          const index = original.index(name);
          store.createIndex(name, index.keyPath, {
            unique: index.unique,
            multiEntry: index.multiEntry,
          });
        }
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
  try {
    await eachBatch(
      source,
      (name, entries) =>
        new Promise<void>((resolve, reject) => {
          const tx = destination.transaction(name, 'readwrite');
          const store = tx.objectStore(name);
          for (const entry of entries) {
            if (store.keyPath === null) store.put(entry.value, entry.key);
            else store.put(entry.value);
          }
          tx.oncomplete = () => {
            resolve();
          };
          tx.onabort = tx.onerror = () => {
            reject(tx.error ?? new Error('Could not copy v1 crypto'));
          };
        })
    );
    const copied = await storeCounts(destination);
    const current = await storeCounts(source);
    if (
      JSON.stringify(counts) !== JSON.stringify(copied) ||
      JSON.stringify(counts) !== JSON.stringify(current)
    )
      throw new Error('The v1 store changed during migration; close other Sable windows and retry');
    if (
      account !== undefined &&
      (account !== JSON.stringify(await readValue(source, 'core', 'account')) ||
        account !== JSON.stringify(await readValue(destination, 'core', 'account')))
    )
      throw new Error(
        'The v1 encryption identity changed during migration; close other Sable windows and retry'
      );
  } finally {
    destination.close();
  }
}

async function storeCounts(database: IDBDatabase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of Array.from(database.objectStoreNames)) {
    counts[name] = await new Promise<number>((resolve, reject) => {
      const tx = database.transaction(name, 'readonly');
      const request = tx.objectStore(name).count();
      tx.oncomplete = () => {
        resolve(request.result);
      };
      tx.onabort = tx.onerror = () => {
        reject(tx.error ?? new Error('Could not count v1 records'));
      };
    });
  }
  return counts;
}

async function availableWebAccountIds(count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let id = 1; ids.length < count; id++) {
    let occupied = false;
    for (const suffix of [
      '::matrix-sdk-crypto',
      '::matrix-sdk-crypto-meta',
      '::matrix-sdk-state',
    ]) {
      const database = await openV1Database(`sable-next-account-a${id}${suffix}`);
      if (database) {
        occupied = true;
        database.close();
      }
    }
    if (!occupied) ids.push(id);
  }
  return ids;
}

function registry(sessions: readonly V1Session[], activeUserId: string | null, ids: number[]) {
  const accounts = sessions.map((session, index) => {
    const meta = { user_id: session.userId, device_id: session.deviceId };
    const tokens = { access_token: session.accessToken, refresh_token: session.refreshToken };
    return {
      account_id: `a${ids[index]}`,
      store_id: `sable-next-account-a${ids[index]}`,
      session: {
        oauth_issuer: session.oidc?.issuer,
        homeserver: session.baseUrl,
        resolved_homeserver: session.baseUrl,
        credentials: session.oidc
          ? { kind: 'o_auth', client_id: session.oidc.clientId, user: { ...meta, ...tokens } }
          : { kind: 'password', ...meta, ...tokens },
      },
    };
  });
  return {
    version: 1,
    active_account_id:
      accounts.at(
        Math.max(
          0,
          sessions.findIndex((session) => session.userId === activeUserId)
        )
      )?.account_id ?? null,
    next_account_id: (ids.at(-1) ?? 0) + 1,
    accounts,
  };
}

async function migrate(): Promise<void> {
  const { isTauri, invoke } = await import('@tauri-apps/api/core');
  const native = isTauri();
  if (
    native
      ? await invoke<boolean>('v1_migration_complete')
      : (await v1MigrationComplete()) || (await loadSession()) !== null
  ) {
    if (!native) await markV1MigrationComplete();
    return;
  }
  const sessions = readV1Sessions(localStorage);
  if (sessions.length === 0) return;
  const credentials = JSON.stringify(sessions);
  const checkCredentials = () => {
    if (JSON.stringify(readV1Sessions(localStorage)) !== credentials)
      throw new Error(
        'The v1 credentials changed during migration; close other Sable windows and retry'
      );
  };
  const rawActive = localStorage.getItem('matrixActiveSession');
  let active: unknown;
  try {
    active = rawActive === null ? null : JSON.parse(rawActive);
  } catch {
    active = null;
  }
  const activeUserId = typeof active === 'string' ? active : null;
  const sources: (IDBDatabase | null)[] = [];
  try {
    for (const session of sessions) sources.push(await findCrypto(session));
    if (native) {
      await invoke('begin_v1_migration', {
        sessions,
        activeUserId,
        snapshots: await Promise.all(
          sources.map(async (source) =>
            source ? { version: source.version, counts: await storeCounts(source) } : null
          )
        ),
      });
      for (const [index, source] of sources.entries()) {
        if (!source) continue;
        if (source.version !== 107)
          throw new Error(`Unsupported v1 crypto schema ${source.version}; its data has been kept`);
        await eachBatch(source, (store, entries) =>
          invoke('import_v1_crypto_batch', {
            accountIndex: index,
            store,
            entries: JSON.parse(
              JSON.stringify(entries, (_key, value: unknown) =>
                value instanceof Uint8Array ? Array.from(value) : value
              )
            ) as unknown,
          })
        );
      }
      checkCredentials();
      await invoke('finish_v1_migration');
    } else {
      if (sources.some((source) => source === null)) {
        throw new Error('The original v1 encryption identity is missing; its data has been kept');
      }
      const ids = await availableWebAccountIds(sessions.length);
      for (const [index, source] of sources.entries()) {
        if (!source) continue;
        const target = `sable-next-account-a${ids[index]}`;
        await copyDatabase(source, `${target}::matrix-sdk-crypto`);
        const meta = await openV1Database(
          source.name.replace(/::matrix-sdk-crypto$/, '::matrix-sdk-crypto-meta')
        );
        if (meta) {
          try {
            await copyDatabase(meta, `${target}::matrix-sdk-crypto-meta`);
          } finally {
            meta.close();
          }
        }
      }
      checkCredentials();
      await saveV1Session(
        new TextEncoder().encode(JSON.stringify(registry(sessions, activeUserId, ids)))
      );
    }
  } finally {
    for (const source of sources) source?.close();
  }
}

export function migrateV1(): Promise<void> | undefined {
  if (!V1_MIGRATION_ENABLED || typeof localStorage === 'undefined') return undefined;
  pending ??= (async () => {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      await navigator.locks.request('sable-v1-migration', migrate);
    } else {
      await migrate();
    }
  })().catch((error: unknown) => {
    pending = undefined;
    throw new V1MigrationError(error instanceof Error ? error.message : String(error));
  });
  return pending;
}
