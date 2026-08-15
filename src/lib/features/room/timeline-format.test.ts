import { expect, test } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';

import type { TimelinePreferences } from '$lib/settings/preferences.svelte';

import {
  foldEventRuns,
  isCollapsed,
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
  layout: 'modern',
  hideMembershipEvents: false,
  hideProfileChanges: true,
  hideMemberInReadOnly: true,
  showTombstoneEvents: false,
  showHiddenEvents: false,
  showNonStandardEvents: false,
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
const topic = item({
  kind: 'state_event',
  event_type: 'm.room.topic',
  state_key: '',
  content: null,
});

test('hides profile changes and raw state events by default, keeping joins', () => {
  const visible = visibleTimelineItems([joined, renamed, topic, message], defaults);
  expect(visible.map((entry) => entry.content.kind)).toEqual(['membership', 'message']);
});

test('honours each toggle independently', () => {
  const shown = visibleTimelineItems([joined, renamed, topic], {
    ...defaults,
    hideMembershipEvents: true,
    hideProfileChanges: false,
    showHiddenEvents: true,
    showNonStandardEvents: true,
  });
  expect(shown.map((entry) => entry.content.kind)).toEqual(['profile_change', 'state_event']);
});

const removed = item({ kind: 'redacted' });

test('keeps tombstones out unless the preference asks for them', () => {
  expect(visibleTimelineItems([removed, message], defaults)).toEqual([message]);
  expect(
    visibleTimelineItems([removed, message], { ...defaults, showTombstoneEvents: true })
  ).toEqual([removed, message]);
});

test('drops member events in a read-only room', () => {
  expect(visibleTimelineItems([joined, message], defaults, { readOnly: true })).toEqual([message]);
  expect(
    visibleTimelineItems(
      [joined, message],
      { ...defaults, hideMemberInReadOnly: false },
      {
        readOnly: true,
      }
    )
  ).toEqual([joined, message]);
});

test('gates raw state events behind both developer switches', () => {
  const master = { ...defaults, showHiddenEvents: true };
  expect(visibleTimelineItems([topic], master)).toEqual([]);
  expect(visibleTimelineItems([topic], { ...master, showNonStandardEvents: true })).toEqual([
    topic,
  ]);
});

test("keeps a persona message out of the account's collapsed run", () => {
  const account = item({ kind: 'message', body: 'a', html: 'a', emote: false, edited: false }, 'a');
  const persona = item({ kind: 'message', body: 'b', html: 'b', emote: false, edited: false }, 'b');
  const items = [
    { ...account, sender: '@a:b', timestamp: 0 },
    { ...persona, sender: '@a:b', timestamp: 1000, per_message_profile: { id: 'kris' } },
  ] as TimelineItemView[];

  expect(isCollapsed(items, 1)).toBe(false);
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
