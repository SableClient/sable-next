import { expect, test, vi } from 'vitest';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { TimelineItemView } from '#src/generated/protocol';
import { TimelineFuture } from './timeline-future.svelte.js';
import { MAX_EMPTY_REFILLS } from './timeline-pagination.svelte.js';

function fixture(load = vi.fn(async () => {})) {
  const timeline = { items: [] } as unknown as RoomTimeline;
  const future = new TimelineFuture(() => timeline, load);
  return { timeline, future, load };
}

test('coalesces requests while a forward page is pending', async () => {
  const pending = Promise.withResolvers<undefined>();
  const { future, load } = fixture(vi.fn(() => pending.promise));
  const first = future.request();
  expect(future.request()).toBe(first);
  expect(future.pending).toBe(true);
  pending.resolve(undefined);
  await first;
  expect(load).toHaveBeenCalledTimes(1);
  expect(future.pending).toBe(false);
});

test('bounds pages without raw progress and lets interaction retry', async () => {
  const { future, load } = fixture();
  for (let i = 0; i < MAX_EMPTY_REFILLS + 3; i++) await future.request();
  expect(load).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS);
  expect(future.canRefill()).toBe(false);
  await future.request(true);
  expect(load).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS + 1);
});

test('raw progress continues paging even when events are hidden', async () => {
  const { timeline, future, load } = fixture();
  for (let i = 0; i < MAX_EMPTY_REFILLS * 2; i++) {
    timeline.items = [
      ...timeline.items,
      {
        id: String(i),
        event_id: `$${i}`,
        content: { kind: 'redacted', reason: null },
      } as TimelineItemView,
    ];
    await future.request();
  }
  expect(load).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS * 2);
});

test('a failed page pauses automatic loading until the reader retries', async () => {
  const { future, load } = fixture(vi.fn(async () => {}));
  load.mockRejectedValueOnce(new Error('offline'));
  await expect(future.request()).rejects.toThrow('offline');
  expect(future.failed).toBe(true);
  await future.request();
  expect(load).toHaveBeenCalledTimes(1);
  await future.request(true);
  expect(future.failed).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
});

test('a stale page cannot clear the next navigation pending state', async () => {
  const old = Promise.withResolvers<undefined>();
  const next = Promise.withResolvers<undefined>();
  const { future } = fixture(
    vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  );
  const first = future.request();
  await Promise.resolve();
  future.reset();
  const second = future.request();
  old.resolve(undefined);
  await first;
  expect(future.pending).toBe(true);
  next.resolve(undefined);
  await second;
  expect(future.pending).toBe(false);
});

test('navigation cancels a queued page before it can load the next room', async () => {
  const { future, load } = fixture();
  const queued = future.request();
  future.reset();
  await queued;
  expect(load).not.toHaveBeenCalled();
});
