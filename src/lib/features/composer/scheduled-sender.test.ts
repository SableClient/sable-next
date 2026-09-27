import { afterEach, expect, test, vi } from 'vitest';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { adoptQueue, scheduledQueue } from './scheduled-queue.svelte';
import { watchScheduledQueue } from './scheduled-sender';

const message = {
  id: 'one',
  roomId: '!room:test',
  body: 'keep me',
  formatted: null,
  dueTs: 0,
  owner: 'A',
};
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  adoptQueue([]);
  vi.useRealTimers();
});

test('a rejected send stays queued and retries on the next tick', async () => {
  vi.useFakeTimers();
  adoptQueue([message]);
  const sendMessage = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(undefined);
  const core = { session: { device_id: 'A' }, commands: { sendMessage } } as unknown as CoreClient;
  stop = watchScheduledQueue(core);
  await vi.advanceTimersByTimeAsync(0);
  expect(scheduledQueue()).toEqual([message]);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(scheduledQueue()).toEqual([]);
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

test('disposing while a send is pending prevents the rest of the batch', async () => {
  vi.useFakeTimers();
  adoptQueue([message, { ...message, id: 'two' }]);
  let finish!: () => void;
  const sendMessage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const core = { session: { device_id: 'A' }, commands: { sendMessage } } as unknown as CoreClient;
  stop = watchScheduledQueue(core);
  stop();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(scheduledQueue().map((entry) => entry.id)).toEqual(['two']);
});

test('an account switch cannot send the remainder of an in-flight batch', async () => {
  vi.useFakeTimers();
  adoptQueue([message, { ...message, id: 'two' }], 'a');
  const session = { account_id: 'a', device_id: 'A' };
  let finish!: () => void;
  const sendMessage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const core = { session, commands: { sendMessage } } as unknown as CoreClient;
  stop = watchScheduledQueue(core);
  session.account_id = 'b';
  finish();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(scheduledQueue('a').map((entry) => entry.id)).toEqual(['two']);
  expect(scheduledQueue('b')).toEqual([]);
  adoptQueue([], 'a');
});
