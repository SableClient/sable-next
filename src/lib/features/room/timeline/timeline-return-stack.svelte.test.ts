// @vitest-environment happy-dom
import { expect, test } from 'vitest';

import { timelineItem } from './test-items.js';
import { TimelineReturnStack } from './timeline-return-stack.svelte.js';

function fixture(loaded: string[], lastVisible: number | null) {
  const state = $state({
    entries: loaded.map((id) => ({
      key: id,
      value: {
        item: timelineItem(id),
        group: null,
        kind: null,
        collapsed: false,
        groupStart: false,
        unreadCount: 0,
      },
    })),
    lastVisible,
  });
  const stack = new TimelineReturnStack({
    entries: () => state.entries,
    lastVisible: () => state.lastVisible,
  });
  return { state, stack };
}

test('an empty stack has nowhere to return to', () => {
  expect(fixture(['a'], 0).stack.eventId).toBeNull();
});

test('returns to the most recent origin that is not visible', () => {
  const { state, stack } = fixture(['a', 'b', 'c'], 1);
  stack.push('$c');
  stack.push('$a');
  expect(stack.eventId).toBe('$c');
  state.lastVisible = 2;
  expect(stack.eventId).toBeNull();
});

test('an origin that is not loaded or has no visible range counts as off screen', () => {
  const { state, stack } = fixture(['a'], 0);
  stack.push('$gone');
  expect(stack.eventId).toBe('$gone');
  stack.clear();
  stack.push('$a');
  expect(stack.eventId).toBeNull();
  state.lastVisible = null;
  expect(stack.eventId).toBe('$a');
});

test('popThrough drops the origin and everything left after it', () => {
  const { stack } = fixture(['a', 'b', 'c'], null);
  stack.push('$c');
  stack.push('$b');
  stack.push('$a');
  stack.popThrough('$b');
  expect(stack.eventId).toBe('$c');
  stack.popThrough('$c');
  expect(stack.eventId).toBeNull();
});

test('clear empties the stack', () => {
  const { stack } = fixture(['a'], null);
  stack.push('$a');
  stack.clear();
  expect(stack.eventId).toBeNull();
});
