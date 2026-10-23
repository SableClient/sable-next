import { deleteDB } from 'idb';
import { expect, test, vi } from 'vitest';

import { loadSnapshot, saveSnapshot } from './snapshot-storage';

test('snapshots persist per account and release their database for account deletion', async () => {
  const account = crypto.randomUUID();
  const key = `snapshot/${account}/rooms/null`;
  const name = `sable-next-account-${account}::snapshots`;
  expect(await loadSnapshot(key)).toBeNull();
  await saveSnapshot(key, '{"count":1}');
  expect(await loadSnapshot(key)).toBe('{"count":1}');
  expect(await loadSnapshot('snapshot/other/rooms/null')).toBeNull();
  await deleteDB(name);
  expect(await loadSnapshot(key)).toBeNull();
  await deleteDB(name);
  await deleteDB('sable-next-account-other::snapshots');
});

test('a transaction aborted after request success rejects without persisting its write', async () => {
  const account = crypto.randomUUID();
  const key = `snapshot/${account}/rooms/null`;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    const request = this.add(value, key);
    request.addEventListener('success', () => {
      this.transaction.abort();
    });
    return request;
  });
  try {
    await expect(saveSnapshot(key, '{}')).rejects.toThrow();
  } finally {
    put.mockRestore();
  }
  expect(await loadSnapshot(key)).toBeNull();
  await deleteDB(`sable-next-account-${account}::snapshots`);
});
