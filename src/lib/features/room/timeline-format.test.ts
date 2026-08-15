import { expect, test } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';

import type { TimelinePreferences } from '$lib/settings/timeline-preferences.svelte';

import {
  foldEventRuns,
  jumboEmojiLevel,
  readReceiptEventId,
  visibleTimelineItems,
} from './timeline-format';

const items = [{ event_id: '$latest' }] as TimelineItemView[];
const visibleAtLatest = {
  focusEventId: null,
  initialAnchorComplete: true,
  nearLatest: true,
  documentVisible: true,
  lastReadEventId: null,
};

test('marks the latest live event read only when the live end is visible', () => {
  expect(readReceiptEventId(items, visibleAtLatest)).toBe('$latest');
  expect(readReceiptEventId(items, { ...visibleAtLatest, nearLatest: false })).toBeNull();
  expect(readReceiptEventId(items, { ...visibleAtLatest, lastReadEventId: '$latest' })).toBeNull();
});

test('does not mark permalink context events as read', () => {
  expect(readReceiptEventId(items, { ...visibleAtLatest, focusEventId: '$target' })).toBeNull();
});

const defaults: TimelinePreferences = {
  hideMembershipEvents: false,
  hideProfileChanges: true,
  showHiddenEvents: false,
};

function item(content: TimelineItemView['content'], id: string = content.kind): TimelineItemView {
  return { id, content } as TimelineItemView;
}

const message = item({ kind: 'message', body: 'hi', html: 'hi', emote: false, edited: false });
const divider = item({ kind: 'date_divider', timestamp: 0 });
const joined = item({ kind: 'membership', user_id: '@a:b', change: 'joined', display_name: null });
const renamed = item({
  kind: 'profile_change',
  user_id: '@a:b',
  display_name: { old: 'a', new: 'b' },
  avatar_changed: false,
});
const topic = item({ kind: 'state_event', event_type: 'm.room.topic', state_key: '' });

test('hides profile changes and raw state events by default, keeping joins', () => {
  const visible = visibleTimelineItems([joined, renamed, topic, message], defaults);
  expect(visible.map((entry) => entry.content.kind)).toEqual(['membership', 'message']);
});

test('honours each toggle independently', () => {
  const shown = visibleTimelineItems([joined, renamed, topic], {
    hideMembershipEvents: true,
    hideProfileChanges: false,
    showHiddenEvents: true,
  });
  expect(shown.map((entry) => entry.content.kind)).toEqual(['profile_change', 'state_event']);
});

test('folds a contiguous run of three or more events behind its head', () => {
  const left = item(
    { kind: 'membership', user_id: '@c:b', change: 'left', display_name: null },
    'c'
  );
  const run = [joined, renamed, left];
  const folded = foldEventRuns([message, ...run, message]);

  expect(folded.items).toEqual([message, joined, message]);
  expect(folded.runs.get(joined.id)).toEqual(run);
});

test('leaves short runs and message-separated events unfolded', () => {
  expect(foldEventRuns([joined, renamed]).runs.size).toBe(0);
  expect(foldEventRuns([joined, message, renamed, message, topic]).runs.size).toBe(0);
});

test('drops a divider whose whole run was filtered out', () => {
  expect(visibleTimelineItems([divider, renamed, divider, message], defaults)).toEqual([
    divider,
    message,
  ]);
  expect(visibleTimelineItems([divider, renamed], defaults)).toEqual([]);
});

test('keeps an unclassified membership change out of the timeline', () => {
  const other = item({ kind: 'membership', user_id: '@a:b', change: 'other', display_name: null });
  expect(visibleTimelineItems([other, message], defaults)).toEqual([message]);
});

test('sizes emoji-only bodies by how many there are', () => {
  expect(jumboEmojiLevel('👍')).toBe(1);
  expect(jumboEmojiLevel('👍🎉')).toBe(2);
  expect(jumboEmojiLevel('👍🎉🔥')).toBe(3);
  expect(jumboEmojiLevel('👍🎉🔥😀😀')).toBe(4);
});

test('leaves ordinary text alone', () => {
  expect(jumboEmojiLevel('nice 👍')).toBeNull();
  expect(jumboEmojiLevel('')).toBeNull();
  // Digits are Emoji_Component, so a bare number must not count as emoji.
  expect(jumboEmojiLevel('123')).toBeNull();
  expect(jumboEmojiLevel('👍👍👍👍👍👍👍👍👍')).toBeNull();
});
