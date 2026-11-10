// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';
import { EventItems, MAX_EVENT_ITEMS } from './event-items.svelte';

const item = (eventId: string) => ({ event_id: eventId }) as TimelineItemView;

function directory() {
  const eventItems = vi.fn(({ event_ids }: { room_id: string; event_ids: string[] }) =>
    Promise.resolve(event_ids.map(item))
  );
  return { items: new EventItems({ eventItems }, () => '@me:x'), eventItems };
}

test('a cold derived reader updates when its first fetch completes', async () => {
  const response = Promise.withResolvers<TimelineItemView[]>();
  const eventItems = vi.fn(() => response.promise);
  const items = new EventItems({ eventItems }, () => '@me:x');
  let latest: TimelineItemView | null = null;
  let pending = false;
  const stop = $effect.root(() => {
    const shown = $derived(items.get('!r', '$a') ?? null);
    $effect(() => {
      latest = shown;
      pending = items.pending('!r', '$a');
    });
  });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(pending).toBe(true);
  });

  response.resolve([item('$a')]);
  await vi.waitFor(() => {
    flushSync();
    expect(latest).toEqual(item('$a'));
    expect(pending).toBe(false);
  });
  stop();
});

test('a reader re-runs only for the event it reads', async () => {
  const { items } = directory();
  let runs = 0;
  const stop = $effect.root(() => {
    $effect(() => {
      items.get('!r', '$a');
      runs += 1;
    });
  });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(items.peek('!r', '$a')).not.toBeNull();
  });
  const settled = runs;

  items.put('!r', [item('$b'), item('$c')]);
  flushSync();
  expect(runs).toBe(settled);
  stop();
});

test('pending reads do not evict cached events or request missing events', () => {
  const { items, eventItems } = directory();
  items.put('!r', [item('$cached')]);
  for (let i = 0; i < MAX_EVENT_ITEMS; i++) {
    expect(items.pending('!r', `$missing${i}`)).toBe(false);
  }
  expect(items.peek('!r', '$cached')).toEqual(item('$cached'));
  expect(eventItems).not.toHaveBeenCalled();
});

test('the cache keeps the most recently used events', () => {
  const { items } = directory();
  items.put('!r', [item('$first')]);
  items.put(
    '!r',
    Array.from({ length: MAX_EVENT_ITEMS - 1 }, (_, i) => item(`$${i}`))
  );
  items.peek('!r', '$first');
  items.get('!r', '$first');
  items.put('!r', [item('$new')]);

  expect(items.peek('!r', '$first')).not.toBeNull();
  expect(items.peek('!r', '$0')).toBeNull();
  expect(items.peek('!r', '$new')).not.toBeNull();
});

test('an event on screen is never evicted from under its reader', () => {
  const { items } = directory();
  items.put('!r', [item('$shown')]);
  const seen: (TimelineItemView | null | undefined)[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(items.get('!r', '$shown'));
    });
  });
  flushSync();
  items.put(
    '!r',
    Array.from({ length: MAX_EVENT_ITEMS * 2 }, (_, i) => item(`$${i}`))
  );
  const edited = { ...item('$shown'), edited: true } as TimelineItemView;
  items.put('!r', [edited]);
  flushSync();

  expect(seen.at(-1)).toBe(edited);
  stop();
});

test('an event whose lookup failed is requested again after a delay, a bounded number of times', async () => {
  vi.useFakeTimers();
  const eventItems = vi.fn(() => Promise.reject(new Error('room not ready')));
  const items = new EventItems({ eventItems }, () => '@me:x');
  let latest: TimelineItemView | null | undefined;
  const stop = $effect.root(() => {
    $effect(() => {
      latest = items.get('!r', '$a');
    });
  });

  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(eventItems).toHaveBeenCalledTimes(1);
  expect(latest).toBeNull();

  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(eventItems).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(5000);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(15000);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(eventItems).toHaveBeenCalledTimes(4);

  await vi.advanceTimersByTimeAsync(60000);
  flushSync();
  expect(eventItems).toHaveBeenCalledTimes(4);
  stop();
  vi.useRealTimers();
});

test('a recovered lookup shows the event and stops retrying', async () => {
  vi.useFakeTimers();
  const eventItems = vi
    .fn<(params: { room_id: string; event_ids: string[] }) => Promise<TimelineItemView[]>>()
    .mockRejectedValueOnce(new Error('room not ready'))
    .mockResolvedValue([item('$a')]);
  const items = new EventItems({ eventItems }, () => '@me:x');
  let latest: TimelineItemView | null | undefined;
  const stop = $effect.root(() => {
    $effect(() => {
      latest = items.get('!r', '$a');
    });
  });

  flushSync();
  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(latest).toEqual(item('$a'));
  await vi.advanceTimersByTimeAsync(60000);
  expect(eventItems).toHaveBeenCalledTimes(2);
  stop();
  vi.useRealTimers();
});

test('a lookup counts as pending until it resolves or runs out of retries', async () => {
  vi.useFakeTimers();
  const eventItems = vi
    .fn<(params: { room_id: string; event_ids: string[] }) => Promise<TimelineItemView[]>>()
    .mockRejectedValue(new Error('room not ready'));
  const items = new EventItems({ eventItems }, () => '@me:x');
  const stop = $effect.root(() => {
    $effect(() => {
      items.get('!r', '$a');
    });
  });

  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(items.pending('!r', '$a')).toBe(true);

  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  await vi.advanceTimersByTimeAsync(5000);
  flushSync();
  await vi.advanceTimersByTimeAsync(15000);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(eventItems).toHaveBeenCalledTimes(4);
  expect(items.pending('!r', '$a')).toBe(false);
  stop();
  vi.useRealTimers();
});

test('an undecryptable event is looked up again and shows once its key arrives', async () => {
  vi.useFakeTimers();
  const utd = {
    event_id: '$a',
    content: { kind: 'unable_to_decrypt', reason: 'unknown', session_id: null },
  } as TimelineItemView;
  const decrypted = {
    event_id: '$a',
    content: { kind: 'message', body: 'hi' },
  } as TimelineItemView;
  const eventItems = vi
    .fn<(params: { room_id: string; event_ids: string[] }) => Promise<TimelineItemView[]>>()
    .mockResolvedValueOnce([utd])
    .mockResolvedValue([decrypted]);
  const items = new EventItems({ eventItems }, () => '@me:x');
  let latest: TimelineItemView | null | undefined;
  const stop = $effect.root(() => {
    $effect(() => {
      latest = items.get('!r', '$a');
    });
  });

  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(latest).toEqual(utd);
  expect(items.pending('!r', '$a')).toBe(false);

  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  expect(items.pending('!r', '$a')).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(latest).toEqual(decrypted);
  await vi.advanceTimersByTimeAsync(60000);
  expect(eventItems).toHaveBeenCalledTimes(2);
  stop();
  vi.useRealTimers();
});
