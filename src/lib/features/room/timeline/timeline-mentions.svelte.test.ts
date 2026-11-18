// @vitest-environment happy-dom
import { expect, test } from 'vitest';

import { timelineItem } from './test-items.js';
import { TimelineMentions } from './timeline-mentions.svelte.js';

function fixture(eventIds: string[], loaded: string[]) {
  const state = $state({
    eventIds,
    items: loaded.map((id) => timelineItem(id)),
    error: null as string | null,
    loading: false,
  });
  const mentions = new TimelineMentions({
    timeline: () => state,
    eventIds: () => state.eventIds,
  });
  return { state, mentions };
}

test('seen mentions leave the pending list', () => {
  const { mentions } = fixture(['$a', '$b'], []);
  expect(mentions.pending).toEqual(['$a', '$b']);
  mentions.markSeen('$a');
  expect(mentions.pending).toEqual(['$b']);
});

test('next targets the oldest pending mention and reports it as jumping until it loads', () => {
  const { state, mentions } = fixture(['$a', '$b'], []);
  expect(mentions.next(() => true)).toBe('$a');
  expect(mentions.jumping).toBe(true);
  expect(mentions.next(() => true)).toBeNull();
  state.items = [timelineItem('a')];
  expect(mentions.jumping).toBe(false);
});

test('a failed timeline stops reporting a jump in progress', () => {
  const { state, mentions } = fixture(['$a'], []);
  mentions.next(() => true);
  state.error = 'offline';
  expect(mentions.jumping).toBe(false);
});

test('a target that becomes seen stops jumping', () => {
  const { mentions } = fixture(['$a'], []);
  mentions.next(() => true);
  mentions.markSeen('$a');
  expect(mentions.jumping).toBe(false);
});

test('next marks a loaded mention that is not shown as seen and moves on', () => {
  const { mentions } = fixture(['$a', '$b'], ['a']);
  expect(mentions.next((eventId) => eventId !== '$a')).toBe('$b');
  expect(mentions.pending).toEqual(['$b']);
});

test('next returns null when no mention is pending', () => {
  const { mentions } = fixture([], []);
  expect(mentions.next(() => true)).toBeNull();
});
