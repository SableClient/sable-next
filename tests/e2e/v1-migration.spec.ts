import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/v1-crypto-18.4.json', import.meta.url), 'utf8')
) as {
  user_id: string;
  device_id: string;
  database: {
    version: number;
    stores: {
      name: string;
      keyPath: string | string[] | null;
      autoIncrement: boolean;
      indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
      records: { key: string; value: unknown }[];
    }[];
  };
};
const session = {
  baseUrl: 'https://example.org',
  userId: fixture.user_id,
  deviceId: fixture.device_id,
  accessToken: 'synthetic-token',
  refreshToken: 'synthetic-refresh',
};
const prefix = `sync${fixture.user_id}`;

type Registry = {
  active_account_id: string | null;
  accounts: { account_id: string; session: { credentials: unknown } }[];
};

async function blank(page: Page) {
  await page.route('**/migration-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Migration fixture</title>',
    })
  );
  await page.goto('/migration-fixture');
}
async function seed(page: Page) {
  await page.evaluate(
    async ({ fixture, session, prefix }) => {
      localStorage.setItem('matrixSessions', JSON.stringify([session]));
      localStorage.setItem('matrixActiveSession', JSON.stringify(session.userId));
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(`${prefix}::matrix-sdk-crypto`, fixture.database.version);
        request.onupgradeneeded = () => {
          for (const table of fixture.database.stores) {
            const store = request.result.createObjectStore(table.name, {
              keyPath: table.keyPath,
              autoIncrement: table.autoIncrement,
            });
            for (const index of table.indexes)
              store.createIndex(index.name, index.keyPath, {
                unique: index.unique,
                multiEntry: index.multiEntry,
              });
            for (const entry of table.records) store.put(entry.value, entry.key);
          }
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB request failed'));
        };
      });
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(`${prefix}::matrix-sdk-crypto-meta`, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('meta').put({ unencrypted: true }, 'fixture');
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB request failed'));
        };
      });
    },
    { fixture, session, prefix }
  );
}
async function migrate(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/lib/migrations/v1/migration.ts';
    const module = (await import(
      path
    )) as typeof import('../../src/lib/migrations/v1/migration.js');
    try {
      await module.migrateV1();
      return null;
    } catch (error) {
      return String(error);
    }
  });
}
async function registry(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/lib/platform/session-storage.ts';
    const module = (await import(
      path
    )) as typeof import('../../src/lib/platform/session-storage.js');
    const bytes = await module.loadSession();
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as Registry) : null;
  });
}
async function dump(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const path = '/src/lib/migrations/v1/migration.ts';
    const module = (await import(
      path
    )) as typeof import('../../src/lib/migrations/v1/migration.js');
    const database: IDBDatabase | null = await module.openV1Database(name);
    if (!database) return null;
    try {
      const stores = [];
      for (const name of Array.from(database.objectStoreNames)) {
        const store = database.transaction(name).objectStore(name);
        const indexes = Array.from(store.indexNames).map((name) => {
          const index = store.index(name);
          return {
            name,
            keyPath: index.keyPath,
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        });
        const records: { key: IDBValidKey; value: unknown }[] = [];
        for (;;) {
          const entries = await module.readV1Batch(database, name, records.at(-1)?.key);
          if (entries.length === 0) break;
          records.push(...entries);
        }
        stores.push({
          name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes,
          records,
        });
      }
      return { version: database.version, stores };
    } finally {
      database.close();
    }
  }, name);
}

test.beforeEach(async ({ page }) => {
  await blank(page);
  await seed(page);
});

test('copies real v1 crypto records and metadata, preserves credentials and source, and never resurrects logout', async ({
  page,
}) => {
  const source = await dump(page, `${prefix}::matrix-sdk-crypto`);
  expect(await migrate(page)).toBeNull();
  const accounts = await registry(page);
  expect(accounts?.accounts[0].session.credentials).toEqual({
    kind: 'password',
    user_id: session.userId,
    device_id: session.deviceId,
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  expect(accounts?.active_account_id).toBe('a1');
  expect(await dump(page, 'sable-next-account-a1::matrix-sdk-crypto')).toEqual(source);
  expect(await dump(page, 'sable-next-account-a1::matrix-sdk-crypto-meta')).toEqual(
    await dump(page, `${prefix}::matrix-sdk-crypto-meta`)
  );
  expect(await dump(page, `${prefix}::matrix-sdk-crypto`)).toEqual(source);
  await page.evaluate(async () => {
    const path = '/src/lib/platform/session-storage.ts';
    const storage = (await import(
      path
    )) as typeof import('../../src/lib/platform/session-storage.js');
    await storage.clearSession();
  });
  await page.reload();
  expect(await migrate(page)).toBeNull();
  expect(await registry(page)).toBeNull();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('matrixSessions') ?? 'null') as unknown
    )
  ).toEqual([session]);
});

test('keeps occupied v2 stores and retries an interrupted copy without publishing a session', async ({
  page,
}) => {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('sable-next-account-a1::matrix-sdk-crypto', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('core').put('keep', 'existing');
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB request failed'));
      };
    });
    const original = Reflect.get(IDBObjectStore.prototype, 'put');
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === 'sable-next-account-a2::matrix-sdk-crypto') {
        IDBObjectStore.prototype.put = original;
        this.transaction.abort();
        throw new DOMException('Fixture storage failure', 'QuotaExceededError');
      }
      return Reflect.apply(original, this, args);
    };
  });
  expect(await migrate(page)).toContain('Fixture storage failure');
  expect(await registry(page)).toBeNull();
  expect(await migrate(page)).toBeNull();
  expect((await registry(page))?.accounts[0].account_id).toBe('a3');
  expect(
    (await dump(page, 'sable-next-account-a1::matrix-sdk-crypto'))?.stores[0]?.records
  ).toEqual([{ key: 'existing', value: 'keep' }]);
  expect(await dump(page, 'sable-next-account-a3::matrix-sdk-crypto')).toEqual(
    await dump(page, `${prefix}::matrix-sdk-crypto`)
  );
});

test('missing original device keys fail without creating a replacement identity', async ({
  page,
}) => {
  await page.evaluate((session) => {
    localStorage.setItem('matrixSessions', JSON.stringify([{ ...session, deviceId: 'WRONG' }]));
  }, session);
  expect(await migrate(page)).toContain('original v1 encryption identity is missing');
  expect(await registry(page)).toBeNull();
  expect(await dump(page, 'sable-next-account-a1::matrix-sdk-crypto')).toBeNull();
});

test('an existing v2 registry is authoritative even if v1 credentials are corrupt', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const path = '/src/lib/platform/session-storage.ts';
    const storage = (await import(
      path
    )) as typeof import('../../src/lib/platform/session-storage.js');
    await storage.saveSession(new TextEncoder().encode(JSON.stringify({ existing: true })));
    localStorage.setItem('matrixSessions', '{broken');
  });
  expect(await migrate(page)).toBeNull();
  expect(await registry(page)).toEqual({ existing: true });
});

test('native carrier exports the complete v1 snapshot before publishing credentials', async ({
  page,
}) => {
  await page.evaluate(() => {
    const calls: { cmd: string; args: unknown }[] = [];
    Object.assign(window, {
      fixtureCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
          return Promise.resolve(cmd === 'v1_migration_complete' ? false : undefined);
        },
      },
    });
    Object.assign(window, { isTauri: true });
  });
  expect(await migrate(page)).toBeNull();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { fixtureCalls: { cmd: string; args: Record<string, unknown> }[] })
        .fixtureCalls
  );
  expect(calls[0].cmd).toBe('v1_migration_complete');
  expect(calls[1].cmd).toBe('begin_v1_migration');
  expect(calls[1].args.sessions).toEqual([session]);
  expect(calls.at(-1)?.cmd).toBe('finish_v1_migration');
  const batches = calls.filter((call) => call.cmd === 'import_v1_crypto_batch');
  expect(batches[0].args.store).toBe('core');
  for (const table of fixture.database.stores) {
    const rows = batches
      .filter((call) => call.args.store === table.name)
      .flatMap((call) => call.args.entries as unknown[]);
    expect(rows).toEqual(
      [...table.records]
        .sort((a, b) => a.key.localeCompare(b.key, 'en', { sensitivity: 'variant' }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    );
  }
  expect(await registry(page)).toBeNull();
});

test('v2 WASM restores the copied v1 device and cross-signing secrets', async ({ page }) => {
  await page.route('https://example.org/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/versions')) {
      await route.fulfill({
        json: { versions: ['v1.11', 'v1.12', 'v1.13'], unstable_features: {} },
      });
    } else if (path.endsWith('/keys/upload')) {
      await route.fulfill({ json: { one_time_key_counts: { signed_curve25519: 50 } } });
    } else if (path.endsWith('/keys/query')) {
      await route.fulfill({ json: { device_keys: {}, failures: {} } });
    } else {
      await route.fulfill({ status: 404, json: { errcode: 'M_NOT_FOUND', error: 'Fixture' } });
    }
  });
  expect(await migrate(page)).toBeNull();
  const restored = await page.evaluate(async () => {
    const wasmPath = '/src/generated/wasm/sable_wasm.js';
    const storagePath = '/src/lib/platform/session-storage.ts';
    const wasm = (await import(
      wasmPath
    )) as typeof import('../../src/generated/wasm/sable_wasm.js');
    const storage = (await import(
      storagePath
    )) as typeof import('../../src/lib/platform/session-storage.js');
    await wasm.default();
    const core = new wasm.SableCore(
      'sable-next',
      storage.loadSession,
      storage.saveSession,
      storage.clearSession,
      'off',
      false
    );
    const session = JSON.parse(await core.submitCommand(JSON.stringify({ type: 'restore' }))) as {
      session: unknown;
    };
    const status = JSON.parse(
      await core.submitCommand(JSON.stringify({ type: 'encryption_status' }))
    ) as { status: { cross_signing_ready: boolean } };
    return { session, status };
  });
  expect(restored.session.session).toMatchObject({
    user_id: session.userId,
    device_id: session.deviceId,
    account_id: 'a1',
  });
  expect(restored.status.status.cross_signing_ready).toBe(true);
});

test('large stores copy all batches before publishing the session', async ({ page }) => {
  await page.evaluate(async (prefix) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`${prefix}::matrix-sdk-crypto`);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB request failed'));
      };
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('core', 'readwrite');
        for (let i = 0; i < 400; i++)
          tx.objectStore('core').put(btoa(JSON.stringify([i % 256])), `custom-${i}`);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onabort = tx.onerror = () => {
          reject(tx.error ?? new Error('IndexedDB transaction failed'));
        };
      });
    } finally {
      database.close();
    }
  }, prefix);
  const source = await dump(page, `${prefix}::matrix-sdk-crypto`);
  expect(await migrate(page)).toBeNull();
  expect(await dump(page, 'sable-next-account-a1::matrix-sdk-crypto')).toEqual(source);
  expect((await registry(page))?.accounts).toHaveLength(1);
});
