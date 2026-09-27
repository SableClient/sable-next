import { expect, test, vi } from 'vitest';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { TimelineItemView } from '#src/generated/protocol';
import { MAX_EMPTY_REFILLS, TimelinePagination } from './timeline-pagination.svelte.js';

test('concurrent history requests share work and release the pending state after failure', async () => {
  const request = Promise.withResolvers<boolean>();
  const load = vi.fn(() => request.promise);
  const timeline = { items: [] } as unknown as RoomTimeline;
  const pagination = new TimelinePagination(() => timeline, load);
  const first = pagination.requestHistory();
  expect(pagination.requestHistory()).toBe(first);
  expect(pagination.pending).toBe(true);
  request.reject(new Error('offline'));
  await expect(first).rejects.toThrow('offline');
  expect(pagination.pending).toBe(false);
  load.mockResolvedValueOnce(true);
  await expect(pagination.requestHistory()).resolves.toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
});

test('refills stop without raw item progress and resume when even hidden items arrive', () => {
  const timeline = { items: [] as TimelineItemView[] };
  const pagination = new TimelinePagination(
    () => timeline as RoomTimeline,
    () => Promise.resolve(false)
  );
  for (let i = 0; i < MAX_EMPTY_REFILLS; i += 1) expect(pagination.canRefill()).toBe(true);
  expect(pagination.canRefill()).toBe(false);
  timeline.items = [{ id: 'hidden' } as TimelineItemView];
  expect(pagination.canRefill()).toBe(true);
  pagination.observeItems();
  pagination.exhausted = true;
  timeline.items = [];
  pagination.observeItems();
  expect(pagination.exhausted).toBe(false);
});
