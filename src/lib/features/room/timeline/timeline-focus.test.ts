// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { TimelineWindow } from '#lib/timeline/timeline-window.js';
import { TimelineFocus } from './timeline-focus';
import { TimelinePagination } from './timeline-pagination.svelte.js';

function fixture() {
  const timeline = {
    mode: { kind: 'focused' },
    error: null,
    items: [],
    forwardPagination: 'idle',
    backwardPagination: 'end',
  } as unknown as RoomTimeline;
  const viewport = document.createElement('div');
  const jump = Promise.withResolvers<boolean>();
  const requestFuture = vi.fn(async () => {});
  const jumpTo = vi.fn(() => jump.promise);
  const focus = new TimelineFocus({
    timeline: () => timeline,
    viewport: () => viewport,
    entries: () => [],
    target: () => '$target',
    history: new TimelinePagination(
      () => timeline,
      () => Promise.resolve(true)
    ),
    requestFuture,
  });
  const engine = { jumpTo, update: vi.fn(async () => {}) } as unknown as TimelineWindow<unknown>;
  return { timeline, focus, engine, jump, jumpTo, requestFuture };
}

test('reader interaction aborts focus positioning before pagination begins', async () => {
  const { focus, engine, jump, jumpTo, requestFuture } = fixture();
  const position = focus.position(engine, '$target', 'row', true);
  const signal = (jumpTo.mock.calls[0] as unknown as [string, string, boolean, AbortSignal])[3];
  focus.cancel();
  expect(signal.aborted).toBe(true);
  jump.resolve(true);
  await position;
  expect(requestFuture).not.toHaveBeenCalled();
  expect(focus.filling).toBe(false);
});

test('switching timeline mode prevents stale focus positioning from fetching more pages', async () => {
  const { timeline, focus, engine, jump, requestFuture } = fixture();
  const position = focus.position(engine, '$target', 'row', false);
  timeline.mode = { kind: 'live' };
  jump.resolve(true);
  await position;
  expect(requestFuture).not.toHaveBeenCalled();
});
