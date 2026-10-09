// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';
import { EventItems, MAX_EVENT_ITEMS } from './event-items.svelte';

const item = (eventId: string) => ({ event_id: eventId }) as TimelineItemView;

function directory() {
  const eventItems = vi.fn((_roomId: string, ids: string[]) => Promise.resolve(ids.map(item)));
  return { items: new EventItems({ eventItems }, () => '@me:x'), eventItems };
}

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
