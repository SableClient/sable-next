import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';

import { JoinQueue, retryDelay } from './join-queue.svelte';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function limited(retryAfterMs: number | null): CoreError {
  return new CoreError({ code: 'rate_limited', retry_after_ms: retryAfterMs });
}

test('retries a rate-limited join after the homeserver delay', async () => {
  const queue = new JoinQueue(vi.fn());
  const run = vi.fn().mockRejectedValueOnce(limited(5000)).mockResolvedValue(true);
  queue.add([{ roomId: '!a:x', run }]);

  await vi.advanceTimersByTimeAsync(4000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(queue.waiting).toBe(true);

  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(queue.done).toBe(1);
  expect(queue.running).toBe(false);
  expect(queue.joined.has('!a:x')).toBe(true);
});

test('joins one room at a time and skips ids it has already seen', async () => {
  const queue = new JoinQueue(vi.fn());
  const order: string[] = [];
  const target = (roomId: string) => ({
    roomId,
    run: () => {
      order.push(roomId);
      return Promise.resolve(true);
    },
  });
  queue.add([target('!a:x'), target('!b:x')]);
  queue.add([target('!a:x')]);
  await vi.runAllTimersAsync();
  expect(order).toEqual(['!a:x', '!b:x']);
  expect(queue.total).toBe(2);
});

test('reports a non-rate-limit failure and carries on', async () => {
  const onFailed = vi.fn();
  const queue = new JoinQueue(onFailed);
  const boom = new CoreError({ code: 'denied' });
  const next = vi.fn().mockResolvedValue(true);
  queue.add([
    { roomId: '!a:x', run: () => Promise.reject(boom) },
    { roomId: '!b:x', run: next },
  ]);
  await vi.runAllTimersAsync();
  expect(onFailed).toHaveBeenCalledWith('!a:x', boom);
  expect(queue.failed).toBe(1);
  expect(next).toHaveBeenCalled();
});

test('cancel stops a pending retry', async () => {
  const queue = new JoinQueue(vi.fn());
  const run = vi.fn().mockRejectedValue(limited(5000));
  queue.add([{ roomId: '!a:x', run }]);
  await vi.advanceTimersByTimeAsync(0);
  queue.cancel();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(queue.running).toBe(false);
});

test('retryDelay clamps the hint and backs off without one', () => {
  expect(retryDelay(limited(10), 0)).toBe(1000);
  expect(retryDelay(limited(5000), 3)).toBe(5000);
  expect(retryDelay(limited(null), 1)).toBe(4000);
  expect(retryDelay(limited(null), 20)).toBe(60_000);
  expect(retryDelay(new CoreError({ code: 'denied' }), 0)).toBeNull();
  expect(retryDelay(new Error('x'), 0)).toBeNull();
});
