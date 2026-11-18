// @vitest-environment happy-dom
import { expect, test } from 'vitest';

import { timelineItem } from './test-items.js';
import { TimelineRows } from './timeline-rows.svelte.js';

function fixture() {
  const state = $state({ items: [timelineItem('a'), timelineItem('b'), timelineItem('c')] });
  const timeline = {
    get items() {
      return state.items;
    },
    aggregations: [],
    backwardPagination: 'end' as const,
    forwardPagination: 'end' as const,
    mode: { kind: 'live' as const },
  };
  const rows = new TimelineRows({
    timeline: () => timeline,
    readOnly: () => false,
    threadRootId: () => null,
    readMarkerBefore: () => null,
    followingRead: () => false,
  });
  return { state, rows };
}

test('unchanged items keep their entry objects across recomputation', () => {
  const { state, rows } = fixture();
  const before = rows.entries;
  state.items = [...state.items];
  const after = rows.entries;
  expect(after).not.toBe(before);
  expect(after.every((entry, index) => entry === before[index])).toBe(true);
});

test('changing one item produces exactly one new entry', () => {
  const { state, rows } = fixture();
  const before = rows.entries;
  state.items = [state.items[0], timelineItem('b', 'edited'), state.items[2]];
  const after = rows.entries;
  const created = after.filter((entry) => !before.includes(entry));
  expect(after).toHaveLength(before.length);
  expect(created).toHaveLength(1);
  expect(created[0].value.item.id).toBe('b');
});
