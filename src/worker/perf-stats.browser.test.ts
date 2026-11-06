import { afterAll, expect, test } from 'vitest';

import { PerfStats } from './perf-stats';

const NAME = 'perf-stats-test';

function request<T>(created: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    created.onsuccess = () => {
      resolve(created.result);
    };
    created.onerror = () => {
      reject(created.error ?? new Error('request failed'));
    };
  });
}

afterAll(async () => {
  await request(indexedDB.deleteDatabase(NAME));
});

test('counts transactions, aborts, requests per store and call latency', async () => {
  const stats = new PerfStats();
  stats.instrument(globalThis);
  const open = indexedDB.open(NAME, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('values').createIndex('by_value', '');
  };
  const database = await request(open);

  const writing = database.transaction('values', 'readwrite');
  await request(writing.objectStore('values').put('a', 'one'));
  const reading = database.transaction('values');
  await request(reading.objectStore('values').get('one'));
  await request(reading.objectStore('values').index('by_value').getAll());
  const aborted = new Promise((resolve) => {
    reading.onabort = resolve;
  });
  reading.abort();
  await aborted;
  database.close();

  stats.recordCall('timeline.subscribe', 40);
  stats.recordCall('timeline.subscribe', 10);

  expect(stats.snapshot(new WebAssembly.Memory({ initial: 1 }))).toEqual({
    idb: {
      transactions: 2,
      requests: 3,
      aborts: 1,
      stores: { 'values.put': 1, 'values.get': 1, 'values.getAll': 1 },
    },
    calls: { 'timeline.subscribe': { count: 2, totalMs: 50, maxMs: 40 } },
    memory: { wasmBytes: 65_536 },
  });
});
