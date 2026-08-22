import { expect, test } from 'vitest';

import type { StateChangeView } from '#src/generated/StateChangeView';
import type { TimelineItemView } from '#src/generated/TimelineItemView';

import { preferences } from '#lib/settings/preferences.svelte.js';
import type { TimelinePreferences } from '#lib/settings/preferences.svelte.js';

import { stateEventText } from './state-event-text';
import {
  canRedact,
  foldEventRuns,
  isCollapsed,
  jumboEmojiLevel,
  readReceiptEventId,
  visibleTimelineItems,
} from './timeline-format';

const items = [{ event_id: '$older' }, { event_id: '$latest' }] as TimelineItemView[];
const scrolledPast = {
  visibleEventId: '$latest',
  documentVisible: true,
  lastReadEventId: null,
};

test('marks the newest event scrolled past', () => {
  expect(readReceiptEventId(items, scrolledPast)).toBe('$latest');
  expect(readReceiptEventId(items, { ...scrolledPast, visibleEventId: '$older' })).toBe('$older');
});

test('does not repeat or rewind the receipt', () => {
  expect(readReceiptEventId(items, { ...scrolledPast, lastReadEventId: '$latest' })).toBeNull();
  expect(
    readReceiptEventId(items, {
      ...scrolledPast,
      visibleEventId: '$older',
      lastReadEventId: '$latest',
    })
  ).toBeNull();
});

test('reads nothing while the document is hidden or no row is past', () => {
  expect(readReceiptEventId(items, { ...scrolledPast, documentVisible: false })).toBeNull();
  expect(readReceiptEventId(items, { ...scrolledPast, visibleEventId: null })).toBeNull();
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

const message = item({
  kind: 'message',
  body: 'hi',
  html: 'hi',
  emote: false,
  notice: false,
  edited: false,
});
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
  change: null,
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
  const account = item(
    { kind: 'message', body: 'a', html: 'a', emote: false, notice: false, edited: false },
    'a'
  );
  const persona = item(
    { kind: 'message', body: 'b', html: 'b', emote: false, notice: false, edited: false },
    'b'
  );
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

function stateChange(change: StateChangeView): TimelineItemView {
  return {
    ...item({
      kind: 'state_event',
      event_type: 'm.room.topic',
      state_key: '',
      content: null,
      change,
    }),
    sender: '@alice:example.org',
    sender_name: 'Alice',
  };
}

test('words the state changes the core recognises', () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    `${key}:${JSON.stringify(values ?? {})}`;

  expect(stateEventText(stateChange({ kind: 'room_name', name: 'Lobby', previous: null }), t)).toBe(
    'timeline.roomNameSet:{"user":"Alice","name":"Lobby"}'
  );
  expect(
    stateEventText(stateChange({ kind: 'room_name', name: 'Lobby', previous: 'Old' }), t)
  ).toBe('timeline.roomNameChanged:{"user":"Alice","name":"Lobby"}');
  expect(stateEventText(stateChange({ kind: 'room_name', name: null, previous: 'Old' }), t)).toBe(
    'timeline.roomNameRemoved:{"user":"Alice"}'
  );
  expect(stateEventText(stateChange({ kind: 'room_topic', topic: null }), t)).toBe(
    'timeline.roomTopicRemoved:{"user":"Alice"}'
  );
  expect(stateEventText(stateChange({ kind: 'room_avatar', removed: true }), t)).toBe(
    'timeline.roomAvatarRemoved:{"user":"Alice"}'
  );
  expect(stateEventText(stateChange({ kind: 'call_membership', joined: true }), t)).toBe(
    'timeline.callJoined:{"user":"Alice"}'
  );
});

test('distinguishes pinning, unpinning and a mixed pin change', () => {
  const key = (change: StateChangeView) => stateEventText(stateChange(change), (k) => k);

  expect(key({ kind: 'pinned_events', added: ['$a'], removed: [], total: 1 })).toBe(
    'timeline.pinnedAdded'
  );
  expect(key({ kind: 'pinned_events', added: [], removed: ['$a'], total: 0 })).toBe(
    'timeline.pinnedRemoved'
  );
  expect(key({ kind: 'pinned_events', added: ['$b'], removed: ['$a'], total: 1 })).toBe(
    'timeline.pinnedChanged'
  );
});

test('an unworded state event keeps its raw type and stays behind the dev toggles', () => {
  const raw = item({
    kind: 'state_event',
    event_type: 'm.room.power_levels',
    state_key: '',
    content: null,
    change: null,
  });

  expect(stateEventText(raw, (k) => k)).toBe('timeline.stateEvent');
  expect(visibleTimelineItems([raw], defaults)).toEqual([]);
  expect(
    visibleTimelineItems([stateChange({ kind: 'room_topic', topic: 'hi' })], defaults)
  ).toHaveLength(1);
});

test('anything you sent is yours to redact, not only your text', () => {
  const own = (content: TimelineItemView['content']) =>
    ({ ...item(content), is_own: true }) as TimelineItemView;
  const theirs = (content: TimelineItemView['content']) =>
    ({ ...item(content), is_own: false }) as TimelineItemView;
  const image = {
    kind: 'image',
    body: 'photo.png',
    source: 'mxc://example.org/p',
    mime: null,
    width: 8,
    height: 8,
  } as const;

  expect(canRedact(own(message.content), false)).toBe(true);
  expect(canRedact(own(image), false), 'an image you sent must be deletable').toBe(true);
  expect(canRedact(theirs(image), false)).toBe(false);
  expect(canRedact(theirs(image), true)).toBe(true);
  // A divider or a state row is not an event anyone can redact.
  expect(canRedact(own(divider.content), true)).toBe(false);
  expect(canRedact(own(joined.content), true)).toBe(false);
});

test('a room whose every event is redacted is not blank at the shipped default', () => {
  const deleted = item({ kind: 'redacted' }, 'gone');

  // A room can be all-redacted — delete every poll in it and this is what is
  // left — and hiding those rows left nothing on screen at all.
  expect(preferences.showTombstoneEvents).toBe(true);
  expect(visibleTimelineItems([deleted], { ...defaults, showTombstoneEvents: true })).toEqual([
    deleted,
  ]);
});
