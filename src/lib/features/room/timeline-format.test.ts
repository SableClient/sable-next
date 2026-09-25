import { expect, test, vi } from 'vitest';

import type {
  MembershipChangeView,
  StateChangeView,
  TimelineItemView,
} from '#src/generated/protocol';

import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import type { TimelinePreferences } from '#lib/settings/preferences.svelte.js';

import { stateEventSubject, stateEventText, type Translate } from './state-event-text';
import {
  formatDate,
  formatMessageTimestamp,
  formatTime,
  canRedact,
  cumulativeReadBy,
  eventBefore,
  isCollapsed,
  isMessageRow,
  jumboEmojiLevel,
  jumboEmoticonLevel,
  mergeAggregations,
  personaLookup,
  readReceiptEventId,
  replyTarget,
  unreadCountAfter,
  visibleAggregations,
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

test('an old message lists everyone who read it or anything after it', () => {
  const timeline = [
    { id: 'old', read_by: [] },
    { id: 'middle', read_by: ['@bob:example.org'] },
    { id: 'new', read_by: ['@carol:example.org'] },
  ] as TimelineItemView[];
  const readers = cumulativeReadBy(timeline);

  expect(readers.get('old')).toEqual(['@bob:example.org', '@carol:example.org']);
  expect(readers.get('middle')).toEqual(['@bob:example.org', '@carol:example.org']);
  expect(readers.get('new')).toEqual(['@carol:example.org']);
});

test('a message keeps its own readers alongside later ones', () => {
  const timeline = [
    { id: 'a', read_by: ['@bob:example.org'] },
    { id: 'b', read_by: ['@bob:example.org', '@carol:example.org'] },
  ] as TimelineItemView[];

  expect(cumulativeReadBy(timeline).get('a')).toEqual(['@bob:example.org', '@carol:example.org']);
});

test('the read marker for a marked-unread message is the event before it', () => {
  const rows = [
    { event_id: '$first' },
    { event_id: null },
    { event_id: '$second' },
  ] as TimelineItemView[];

  expect(eventBefore(rows, '$second')).toBe('$first');
  expect(eventBefore(rows, '$first')).toBeNull();
  expect(eventBefore(rows, '$missing')).toBeNull();
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
  hiddenEventEdits: true,
  hiddenEventReactions: true,
  hiddenEventRedactions: true,
  hiddenEventOther: true,
};

function aggregation(eventType: string, id: string): TimelineItemView {
  return {
    id,
    content: { kind: 'hidden_event', event_type: eventType, content: null },
  } as unknown as TimelineItemView;
}

test('an aggregation is filtered by its own event type', () => {
  const on: TimelinePreferences = { ...defaults, showHiddenEvents: true };
  const aggregations = [
    aggregation('m.reaction', '$reaction'),
    aggregation('m.room.redaction', '$redaction'),
    aggregation('m.room.message', '$edit'),
    aggregation('m.beacon', '$beacon'),
  ];

  expect(visibleAggregations(aggregations, defaults)).toEqual([]);
  expect(visibleAggregations(aggregations, on).map((entry) => entry.id)).toEqual([
    '$reaction',
    '$redaction',
    '$edit',
    '$beacon',
  ]);
  expect(
    visibleAggregations(aggregations, {
      ...on,
      hiddenEventReactions: false,
      hiddenEventOther: false,
    }).map((entry) => entry.id)
  ).toEqual(['$redaction', '$edit']);
});

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
const readMarker = item({ kind: 'read_marker' });
const joined = item({
  kind: 'membership',
  user_id: '@a:b',
  change: 'joined',
  display_name: null,
  reason: null,
});
const renamed = item({
  kind: 'profile_change',
  user_id: '@a:b',
  display_name: { old: 'a', new: 'b' },
  avatar: null,
});
const topic = item({
  kind: 'state_event',
  event_type: 'm.room.topic',
  state_key: '',
  content: null,
  change: null,
});

function withEvent(row: TimelineItemView, eventId: string | null): TimelineItemView {
  return { ...row, id: eventId ?? row.id, event_id: eventId };
}

const replyRows = [
  withEvent(message, '$first'),
  withEvent(joined, '$joined'),
  withEvent(item({ kind: 'redacted', reason: null }), '$redacted'),
  withEvent(divider, null),
  withEvent(message, '$second'),
  withEvent(message, null),
];

test('the first reply step picks the latest message, skipping echoes', () => {
  expect(replyTarget(replyRows, null, 'older', false)).toBe('$second');
  expect(replyTarget(replyRows, null, 'newer', false)).toBeNull();
});

test('reply steps skip redactions and non-message rows unless hidden events are shown', () => {
  expect(replyTarget(replyRows, '$second', 'older', false)).toBe('$first');
  expect(replyTarget(replyRows, '$first', 'newer', false)).toBe('$second');
  expect(replyTarget(replyRows, '$second', 'older', true)).toBe('$joined');
});

test('a reply step stays on the oldest row and clears past the newest', () => {
  expect(replyTarget(replyRows, '$first', 'older', false)).toBe('$first');
  expect(replyTarget(replyRows, '$second', 'newer', false)).toBeNull();
});

test('a reply to a row that is not shown restarts from the latest message', () => {
  expect(replyTarget(replyRows, '$elsewhere', 'older', false)).toBe('$second');
  expect(replyTarget(replyRows, '$joined', 'older', false)).toBe('$second');
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
  });
  expect(shown.map((entry) => entry.content.kind)).toEqual(['profile_change', 'state_event']);
});

const removed = item({ kind: 'redacted', reason: null });

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

test('gates raw state events behind the developer switch', () => {
  expect(visibleTimelineItems([topic], defaults)).toEqual([]);
  expect(visibleTimelineItems([topic], { ...defaults, showHiddenEvents: true })).toEqual([topic]);
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

test('groups media with the messages around it', () => {
  const picture = {
    ...item({ kind: 'image' } as TimelineItemView['content'], 'picture'),
    sender: '@a:b',
    timestamp: 0,
  } as TimelineItemView;
  const text = { ...message, id: 'text', sender: '@a:b', timestamp: 1000 } as TimelineItemView;
  const later = { ...picture, id: 'later', timestamp: 2000 };

  expect(isCollapsed([picture, text], 1)).toBe(true);
  expect(isCollapsed([text, later], 1)).toBe(true);
  expect(isCollapsed([picture, later], 1)).toBe(true);
});

test('only a connected reply preview starts a new message group', () => {
  const first = {
    ...message,
    id: 'first',
    sender: '@a:b',
    timestamp: 0,
    in_reply_to: null,
  } as TimelineItemView;
  const reply = {
    ...message,
    id: 'reply',
    sender: '@a:b',
    timestamp: 1000,
    in_reply_to: {
      event_id: '$original',
      sender: '@b:b',
      sender_mentioned: false,
      sender_name: 'Bob',
      body: 'Earlier message',
    },
  } as TimelineItemView;
  const run = [first, reply];

  expect(isCollapsed(run, 1, 'connected')).toBe(false);
  expect(isCollapsed(run, 1, 'compact')).toBe(true);
  expect(isCollapsed(run, 1, 'expanded')).toBe(true);
});

test('drops a divider whose whole run was filtered out', () => {
  expect(visibleTimelineItems([divider, renamed, divider, message], defaults)).toEqual([
    divider,
    message,
  ]);
  expect(visibleTimelineItems([divider, renamed], defaults)).toEqual([]);
});

test('shows read markers only before unread messages', () => {
  expect(visibleTimelineItems([message, readMarker], defaults)).toEqual([message]);
  expect(visibleTimelineItems([readMarker, message, readMarker], defaults)).toEqual([
    readMarker,
    message,
  ]);
  expect(visibleTimelineItems([readMarker, divider, message], defaults)).toEqual([
    readMarker,
    divider,
    message,
  ]);
  expect(visibleTimelineItems([divider, readMarker, message], defaults)).toEqual([
    divider,
    readMarker,
    message,
  ]);
  const ownMessage = { ...message, id: 'own', is_own: true };
  expect(visibleTimelineItems([message, readMarker, ownMessage], defaults)).toEqual([
    message,
    ownMessage,
  ]);
  const renamedRoom = stateChange({ kind: 'room_name', name: 'Lobby', previous: null });
  expect(visibleTimelineItems([message, readMarker, renamedRoom], defaults)).toEqual([
    message,
    renamedRoom,
  ]);
});

test('keeps an unclassified membership change out of the timeline', () => {
  const other = item({
    kind: 'membership',
    user_id: '@a:b',
    change: 'other',
    display_name: null,
    reason: null,
  });
  expect(visibleTimelineItems([other, message], defaults)).toEqual([message]);
  expect(visibleTimelineItems([other, message], { ...defaults, showHiddenEvents: true })).toEqual([
    other,
    message,
  ]);
  expect(
    visibleTimelineItems([other, message], {
      ...defaults,
      showHiddenEvents: true,
      hideMembershipEvents: true,
    })
  ).toEqual([message]);
});

test('slots aggregation rows into the timeline by timestamp', () => {
  const at = (id: string, timestamp: number): TimelineItemView => ({
    ...item({ kind: 'hidden_event', event_type: 'm.reaction', content: null }, id),
    timestamp,
  });
  const sent = { ...message, timestamp: 10 };
  const before = at('$before', 9);
  const after = at('$after', 11);

  const whole = { start: true, end: true };
  expect(mergeAggregations([sent], [after, before], whole)).toEqual([before, sent, after]);
  expect(mergeAggregations([sent], [], whole)).toEqual([sent]);
  expect(mergeAggregations([sent, before], [before], whole)).toEqual([sent, before]);
});

test('drops aggregation rows outside the loaded range', () => {
  const at = (id: string, timestamp: number): TimelineItemView => ({
    ...item({ kind: 'hidden_event', event_type: 'm.reaction', content: null }, id),
    timestamp,
  });
  const first = { ...message, id: 'first', event_id: '$first', timestamp: 10 };
  const last = { ...message, id: 'last', event_id: '$last', timestamp: 20 };
  const older = at('$older', 5);
  const inside = at('$inside', 15);
  const newer = at('$newer', 25);
  const aggregations = [older, inside, newer];

  expect(mergeAggregations([first, last], aggregations, { start: false, end: true })).toEqual([
    first,
    inside,
    last,
    newer,
  ]);
  expect(mergeAggregations([first, last], aggregations, { start: false, end: false })).toEqual([
    first,
    inside,
    last,
  ]);
  expect(mergeAggregations([], aggregations, { start: false, end: true })).toEqual([]);
});

test('a live location share counts as unread', () => {
  const marker = item({ kind: 'read_marker' }, 'marker');
  const share = {
    ...item({ kind: 'live_location' } as TimelineItemView['content'], '$share'),
    is_own: false,
  };
  expect(unreadCountAfter([marker, share], 0)).toBe(1);
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

const emote = (name: string) =>
  `<img alt="${name}" height="32" src="mxc://example.org/${name}" title="${name}">`;

test('sizes a message made only of inline emotes, by how many there are', () => {
  expect(
    jumboEmoticonLevel('<img alt="rotate" height="32" src="mxc://a/rotate" title="rotate"> ')
  ).toBe(1);
  expect(jumboEmoticonLevel(`<p>${emote('rotate')}</p>`)).toBe(1);
  expect(jumboEmoticonLevel(`${emote('rotate')}<br>${emote('spin')}`)).toBe(2);
  expect(jumboEmoticonLevel(`${emote('a')} ${emote('b')}`)).toBe(2);
  expect(jumboEmoticonLevel(`${emote('a')} ${emote('b')} ${emote('c')} ${emote('d')}`)).toBe(3);
  expect(jumboEmoticonLevel('<img src="mxc://a/rotate" alt="a > b">')).toBe(1);
  expect(jumboEmoticonLevel('<img src="mxc://a/rotate" alt=":rotate:">&nbsp;')).toBe(1);
});

test('leaves messages with words or real images at normal size', () => {
  expect(jumboEmoticonLevel(`nice ${emote('rotate')}`)).toBeNull();
  expect(jumboEmoticonLevel('')).toBeNull();
  expect(jumboEmoticonLevel('<img src="https://example.org/photo.png" width="640">')).toBeNull();
  expect(
    jumboEmoticonLevel(`${emote('rotate')}<img src="https://example.org/photo.png">`)
  ).toBeNull();
  expect(jumboEmoticonLevel('<a href="https://example.org">link</a>')).toBeNull();
  expect(jumboEmoticonLevel(`${emote('rotate')} and words`)).toBeNull();
  expect(jumboEmoticonLevel(Array.from({ length: 9 }, () => emote('rotate')).join(' '))).toBeNull();
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

test('names the moderator and the reason on a membership someone else performed', () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    `${key}:${JSON.stringify(values ?? {})}`;
  const membership = (
    change: MembershipChangeView,
    reason: string | null,
    sender: string,
    senderName: string | null = null
  ): TimelineItemView => ({
    ...item({ kind: 'membership', user_id: '@bob:b', change, display_name: 'Bob', reason }),
    sender,
    sender_name: senderName,
  });

  expect(stateEventText(membership('kicked', null, '@alice:b', 'Alice'), t)).toBe(
    'timeline.membershipBy.kicked:{"user":"Bob","actor":"Alice"}'
  );
  const key = (key: string) => key;
  expect(stateEventText(membership('banned', 'spam', '@alice:b', 'Alice'), key)).toBe(
    'timeline.withReason'
  );

  expect(stateEventText(membership('left', null, '@bob:b', 'Bob'), t)).toBe(
    'timeline.membership.left:{"user":"Bob"}'
  );
  expect(stateEventText(membership('kicked', null, '@bob:b', 'Bob'), t)).toBe(
    'timeline.membership.kicked:{"user":"Bob"}'
  );
  expect(stateEventText(membership('kicked', '', '@alice:b', 'Alice'), t)).toBe(
    'timeline.membershipBy.kicked:{"user":"Bob","actor":"Alice"}'
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
    'timeline.pinnedBoth'
  );
  expect(key({ kind: 'pinned_events', added: [], removed: [], total: 1 })).toBe(
    'timeline.pinnedUnchanged'
  );
});

test('a mixed pin change reports both counts, as v1 does', () => {
  const t: Translate = (key, values) =>
    key === 'timeline.pinnedBoth' ? `${String(values?.added)} / ${String(values?.removed)}` : key;

  expect(
    stateEventText(
      stateChange({ kind: 'pinned_events', added: ['$a', '$b'], removed: ['$c'], total: 2 }),
      t
    )
  ).toBe('timeline.pinnedAddedPart / timeline.pinnedRemovedPart');
});

test('an unworded state event keeps its raw type and stays behind the dev toggles', () => {
  const raw = item({
    kind: 'state_event',
    event_type: 'm.room.power_levels',
    state_key: '',
    content: null,
    change: null,
  });

  expect(stateEventText(raw, (k) => k)).toBe('timeline.hiddenStateEvent');
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
    html: null,
    source: 'mxc://example.org/p',
    filename: 'photo.png',
    caption: null,
    mime: null,
    width: 8,
    height: 8,
    size: null,
    blurhash: null,
    thumbnail: null,
    spoiler: null,
  } as const;

  expect(canRedact(own(message.content), true, false)).toBe(true);
  expect(canRedact(own(image), true, false), 'an image you sent must be deletable').toBe(true);
  expect(canRedact(own(message.content), false, true), 'redactions barred by power levels').toBe(
    false
  );
  expect(canRedact(theirs(image), true, false)).toBe(false);
  expect(canRedact(theirs(image), true, true)).toBe(true);
  expect(canRedact(own(joined.content), true, false)).toBe(true);
  expect(canRedact(theirs(joined.content), true, true)).toBe(true);
  expect(canRedact(own(divider.content), true, true)).toBe(false);
  expect(canRedact(own({ kind: 'redacted', reason: null }), true, true)).toBe(false);
});

test('a tombstone is a message row, so it keeps the sender and the menu', () => {
  expect(isMessageRow({ kind: 'redacted', reason: null })).toBe(true);
});

test('a room whose every event is redacted is not blank at the shipped default', () => {
  const deleted = item({ kind: 'redacted', reason: null }, 'gone');

  // A room can be all-redacted — delete every poll in it and this is what is
  // left — and hiding those rows left nothing on screen at all.
  expect(preferences.showTombstoneEvents).toBe(true);
  expect(visibleTimelineItems([deleted], { ...defaults, showTombstoneEvents: true })).toEqual([
    deleted,
  ]);
});

test('splits the state copy around the subject so the name can open a profile', () => {
  const interpolate = (key: string, values?: Record<string, unknown>) =>
    `${key} by ${String(values?.user)}.`;

  expect(stateEventSubject(joined, interpolate)).toEqual({
    userId: '@a:b',
    name: '@a:b',
    before: 'timeline.membership.joined by ',
    after: '.',
  });
  expect(stateEventSubject(renamed, interpolate)?.name).toBe('a');
  expect(stateEventSubject(stateChange({ kind: 'room_topic', topic: null }), interpolate)).toEqual({
    userId: '@alice:example.org',
    name: 'Alice',
    before: 'timeline.roomTopicRemoved by ',
    after: '.',
  });
});

test('leaves copy with no subject unlinked', () => {
  expect(stateEventSubject(message, (k) => k)).toBeNull();
  expect(
    stateEventSubject(
      item({
        kind: 'state_event',
        event_type: 'm.room.power_levels',
        state_key: '',
        content: null,
        change: null,
      }),
      (k) => k
    )
  ).toBeNull();
});

test('the persona lookup resolves a reply target and reports a miss as null', () => {
  const items = [
    { event_id: '$a', per_message_profile: { display_name: 'Ghost' } },
    { event_id: '$b', per_message_profile: null },
  ] as unknown as TimelineItemView[];
  const lookup = personaLookup(items);

  expect(lookup('$a')?.display_name).toBe('Ghost');
  expect(lookup('$b')).toBeNull();
  expect(lookup('$missing')).toBeNull();
});

test('the persona lookup reads the items only when first asked', () => {
  let reads = 0;
  const items = new Proxy([{ event_id: '$a', per_message_profile: { display_name: 'Ghost' } }], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) reads += 1;

      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as unknown as TimelineItemView[];

  const lookup = personaLookup(items);
  expect(reads).toBe(0);

  lookup('$a');
  lookup('$a');
  expect(reads).toBe(1);
});

test('formatTime follows the 24-hour clock preference', () => {
  const afternoon = new Date(2026, 0, 1, 13, 5).getTime();
  const midnight = new Date(2026, 0, 1, 0, 5).getTime();
  const previous = preferences.hour24Clock;

  setPreference('hour24Clock', true);
  expect(formatTime(afternoon)).toBe('13:05');
  expect(formatTime(midnight)).toBe('00:05');

  setPreference('hour24Clock', false);
  expect(formatTime(afternoon)).toBe(
    new Date(afternoon).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  );

  setPreference('hour24Clock', previous);
});

test('formatDate uses translated day names', () => {
  const now = new Date(2026, 8, 1, 14, 0);
  vi.useFakeTimers();
  vi.setSystemTime(now);

  expect(formatDate(now.getTime())).toBe('Today');
  const yesterday = new Date(2026, 7, 31, 10, 0);
  expect(formatDate(yesterday.getTime())).toBe('Yesterday');

  vi.useRealTimers();
});

test('formatMessageTimestamp shows time only for today', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  expect(formatMessageTimestamp(now.getTime())).toBe('14:30');

  vi.useRealTimers();
});

test('formatMessageTimestamp shows yesterday with time', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  const yesterday = new Date(2026, 7, 31, 9, 15);
  expect(formatMessageTimestamp(yesterday.getTime())).toBe('Yesterday 09:15');

  vi.useRealTimers();
});

test('formatMessageTimestamp shows month and day for older messages in the same year', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  const older = new Date(2026, 7, 24, 9, 15);
  expect(formatMessageTimestamp(older.getTime())).toBe('August 24 09:15');

  vi.useRealTimers();
});

test('formatMessageTimestamp includes the year for messages from another year', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  const lastYear = new Date(2025, 7, 24, 9, 15);
  expect(formatMessageTimestamp(lastYear.getTime())).toBe('August 24, 2025 09:15');

  vi.useRealTimers();
});

test('a hidden event names its sender, as v1 does', () => {
  const t: Translate = (key, values) => `${key}:${JSON.stringify(values)}`;
  const hidden = (eventType: string, content: unknown): TimelineItemView => ({
    ...item({ kind: 'hidden_event', event_type: eventType, content }),
    sender: '@alice:example.org',
    sender_name: 'Alice',
  });

  expect(stateEventText(hidden('m.key.verification.start', null), t)).toBe(
    'timeline.hiddenEvent:{"user":"Alice","type":"m.key.verification.start"}'
  );
  expect(stateEventText(hidden('m.room.redaction', null), t)).toBe(
    'timeline.hiddenRedaction:{"user":"Alice"}'
  );
});

test('a hidden reaction reports the key it carries', () => {
  const t: Translate = (key, values) => `${key}:${JSON.stringify(values)}`;
  const reaction = (content: unknown): TimelineItemView => ({
    ...item({ kind: 'hidden_event', event_type: 'm.reaction', content }),
    sender: '@alice:example.org',
    sender_name: 'Alice',
  });

  expect(stateEventText(reaction({ 'm.relates_to': { key: '👍' } }), t)).toBe(
    'timeline.hiddenReaction:{"user":"Alice","key":"👍"}'
  );
  expect(stateEventText(reaction({ shortcode: 'party', 'm.relates_to': { key: 'x' } }), t)).toBe(
    'timeline.hiddenReaction:{"user":"Alice","key":":party:"}'
  );
  expect(stateEventText(reaction({ 'm.relates_to': {} }), t)).toBe(
    'timeline.hiddenEvent:{"user":"Alice","type":"m.reaction"}'
  );
});

test('a cleared avatar is not the same sentence as a replaced one', () => {
  const avatarChange = (newUrl: string | null): TimelineItemView =>
    item({
      kind: 'profile_change',
      user_id: '@bob:example.org',
      display_name: null,
      avatar: { old: 'mxc://example.org/old', new: newUrl },
    });

  expect(stateEventText(avatarChange('mxc://example.org/new'), (k) => k)).toBe(
    'timeline.profileAvatarChanged'
  );
  expect(stateEventText(avatarChange(null), (k) => k)).toBe('timeline.profileAvatarRemoved');
});
