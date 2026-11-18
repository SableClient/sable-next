// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';

import type { TimelineWindowState } from '#lib/timeline/timeline-window.js';

import { timelineItem } from './test-items.js';
import { TimelineReadPosition } from './timeline-read-position.svelte.js';
import type { RowValue } from './timeline-rows.svelte.js';

function row(index: number, id: string) {
  return {
    index,
    key: id,
    value: {
      item: timelineItem(id),
      group: null,
      kind: null,
      collapsed: false,
      groupStart: false,
      unreadCount: 0,
    } satisfies RowValue,
  };
}

function fixture(roomId: string | null = '!room:example.org') {
  const windowState: TimelineWindowState<RowValue> = {
    start: 0,
    end: 3,
    firstVisible: 0,
    lastVisible: 2,
    lastFullyVisible: 1,
    rows: [row(0, 'a'), row(1, 'b'), row(2, 'c')],
    pinned: true,
    scrolling: false,
  };
  const state = $state({
    items: [timelineItem('a'), timelineItem('b'), timelineItem('c')],
    canRead: true,
    windowState,
  });
  const onFullyRead = vi.fn();
  const position = new TimelineReadPosition({
    roomId,
    timeline: () => state,
    windowState: () => state.windowState,
    canRead: () => state.canRead,
    onFullyRead: () => onFullyRead,
  });
  return { state, position, onFullyRead };
}

test('nothing is read until reading is allowed', () => {
  const { state, position } = fixture();
  expect(position.eventId).toBe('$c');
  state.canRead = false;
  expect(position.eventId).toBeNull();
});

test('pinned at the live edge reads up to the latest event, falling back to the window rows', () => {
  const { state, position } = fixture();
  state.items = [];
  expect(position.eventId).toBe('$c');
});

test('scrolled back reads up to the last fully visible event', () => {
  const { state, position } = fixture();
  state.windowState = { ...state.windowState, pinned: false };
  expect(position.eventId).toBe('$b');
  state.windowState = { ...state.windowState, lastFullyVisible: null };
  expect(position.eventId).toBeNull();
});

test('settle reports the furthest read event once', () => {
  const { position, onFullyRead } = fixture();
  position.settle();
  expect(onFullyRead).not.toHaveBeenCalled();
  position.advance('$b');
  position.settle();
  position.settle();
  expect(onFullyRead).toHaveBeenCalledExactlyOnceWith('!room:example.org', '$b');
  position.advance('$c');
  position.settle();
  expect(onFullyRead).toHaveBeenLastCalledWith('!room:example.org', '$c');
});

test('settle skips what was already marked fully read', () => {
  const { position, onFullyRead } = fixture();
  position.advance('$c');
  position.markFullyRead('$c');
  position.settle();
  expect(onFullyRead).not.toHaveBeenCalled();
});

test('settle does nothing without a room', () => {
  const { position, onFullyRead } = fixture(null);
  position.advance('$c');
  position.settle();
  expect(onFullyRead).not.toHaveBeenCalled();
});
