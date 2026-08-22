import { expect, test, vi } from 'vitest';

import { SendQueue } from './send-queue';

const started = (): Promise<void> => Promise.resolve();

test('runs one operation at a time, in order', async () => {
  const queue = new SendQueue();
  const order: string[] = [];
  const gate = Promise.withResolvers<undefined>();

  const first = queue.enqueue(async () => {
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
  });
  const second = queue.enqueue(() => {
    order.push('second');
    return Promise.resolve();
  });

  await started();
  expect(order).toEqual(['first:start']);

  gate.resolve(undefined);
  await Promise.all([first, second]);

  expect(order).toEqual(['first:start', 'first:end', 'second']);
});

test('a failure reaches its caller without stopping the queue', async () => {
  const queue = new SendQueue();
  const failed = queue.enqueue(() => Promise.reject(new Error('offline')));
  const next = vi.fn(() => Promise.resolve('sent'));

  await expect(failed).rejects.toThrow('offline');
  await expect(queue.enqueue(next)).resolves.toBe('sent');
});

test('an operation already running learns that the composer is gone', async () => {
  const queue = new SendQueue();
  const gate = Promise.withResolvers<undefined>();
  let liveAfterDisposal: boolean | undefined;

  const running = queue.enqueue(async (isLive) => {
    await gate.promise;
    liveAfterDisposal = isLive();
  });
  await started();

  queue.dispose();
  gate.resolve(undefined);
  await running;

  expect(liveAfterDisposal).toBe(false);
});

test('disposal drops work that has not started', async () => {
  const queue = new SendQueue();
  const operation = vi.fn(() => Promise.resolve('sent'));

  queue.dispose();

  await expect(queue.enqueue(operation)).resolves.toBeUndefined();
  expect(operation).not.toHaveBeenCalled();
});
