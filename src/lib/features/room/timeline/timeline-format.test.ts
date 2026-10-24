import type { ResolvedItem, ResolvedRow } from '#lib/rooms/timeline-item.js';
import { expect, test } from 'vitest';

import type {
  MembershipChangeView,
  PerMessageProfileView,
  StateChangeView,
} from '#src/generated/protocol';

import { rowFields } from './row-fixtures';
import { stateEventSubject, stateEventText, type Translate } from './state-event-text';
import { canRedact, personaLookup, readReceiptEventId, replyTarget } from './timeline-format';

const items = [{ event_id: '$older' }, { event_id: '$latest' }] as ResolvedItem[];
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

const noReceipts: Pick<ResolvedItem, 'read_by' | 'read_timestamps'> = {
  read_by: [],
  read_timestamps: {},
};

function item(content: ResolvedItem['content'], id: string = content.kind): ResolvedItem {
  return { id, content, ...noReceipts, ...rowFields(content) } as ResolvedItem;
}

const message = item({
  kind: 'message',
  body: 'hi',
  html: 'hi',
  emote: false,
  notice: false,
  edited: false,
});

const joined = item({
  kind: 'membership',
  user_id: '@a:b',
  change: 'joined',
  display_name: null,
  reason: null,
});

const divider = item({ kind: 'date_divider', timestamp: 0 });
const renamed = item({
  kind: 'profile_change',
  user_id: '@a:b',
  display_name: { old: 'a', new: 'b' },
  avatar: null,
});

function stateChange(change: StateChangeView): ResolvedItem {
  return {
    ...item({
      kind: 'state_event',
      event_type: 'm.room.topic',
      state_key: '',
      content: null,
      prev_content: null,
      change,
    }),
    sender: '@alice:example.org',
    sender_name: 'Alice',
  };
}

function row(eventId: string | null, replyTargetFlag: boolean): ResolvedRow {
  return {
    key: eventId ?? 'echo',
    reply_target: replyTargetFlag,
    item: { event_id: eventId } as ResolvedItem,
    group: null,
    segments: [],
    collapsed: false,
    group_start: false,
    unread_count: 0,
    receipts: null,
  };
}

const replyRows = [
  row('$first', true),
  row('$joined', false),
  row(null, false),
  row('$second', true),
];

test('the first reply step picks the latest message', () => {
  expect(replyTarget(replyRows, null, 'older')).toBe('$second');
  expect(replyTarget(replyRows, null, 'newer')).toBeNull();
});

test('reply steps skip the rows the runtime does not offer', () => {
  expect(replyTarget(replyRows, '$second', 'older')).toBe('$first');
  expect(replyTarget(replyRows, '$first', 'newer')).toBe('$second');
});

test('a reply step stays on the oldest row and clears past the newest', () => {
  expect(replyTarget(replyRows, '$first', 'older')).toBe('$first');
  expect(replyTarget(replyRows, '$second', 'newer')).toBeNull();
});

test('a reply to a row that is not offered restarts from the latest message', () => {
  expect(replyTarget(replyRows, '$elsewhere', 'older')).toBe('$second');
  expect(replyTarget(replyRows, '$joined', 'older')).toBe('$second');
});

test('a folded run offers each of its members', () => {
  const folded: ResolvedRow = {
    ...row('$b', true),
    group: [
      { reply_target: true, item: { event_id: '$a' } as ResolvedItem },
      { reply_target: false, item: { event_id: '$x' } as ResolvedItem },
      { reply_target: true, item: { event_id: '$b' } as ResolvedItem },
    ],
  };
  expect(replyTarget([folded], '$b', 'older')).toBe('$a');
});

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
  ): ResolvedItem => ({
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

test('anything you sent is yours to redact, not only your text', () => {
  const own = (content: ResolvedItem['content']) =>
    ({ ...item(content), is_own: true }) as ResolvedItem;
  const theirs = (content: ResolvedItem['content']) =>
    ({ ...item(content), is_own: false }) as ResolvedItem;
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
    animated: null,
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
  expect(canRedact(own({ kind: 'redacted', reason: null, redacted_by: null }), true, true)).toBe(
    false
  );
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
        prev_content: null,
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
  ] as unknown as ResolvedItem[];
  const lookup = personaLookup(items);

  expect(lookup('$a')?.display_name).toBe('Ghost');
  expect(lookup('$b')).toBeNull();
  expect(lookup('$missing')).toBeNull();
});

test('the persona lookup asks the fallback only for a target outside the window', () => {
  const items = [{ event_id: '$a', per_message_profile: null }] as unknown as ResolvedItem[];
  const asked: (string | null | undefined)[] = [];
  const lookup = personaLookup(items, (eventId) => {
    asked.push(eventId);
    return { display_name: 'Ghost' } as PerMessageProfileView;
  });

  expect(lookup('$a')).toBeNull();
  expect(lookup('$old')?.display_name).toBe('Ghost');
  expect(asked).toEqual(['$old']);
});

test('the persona lookup reads the items only when first asked', () => {
  let reads = 0;
  const items = new Proxy([{ event_id: '$a', per_message_profile: { display_name: 'Ghost' } }], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) reads += 1;

      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as unknown as ResolvedItem[];

  const lookup = personaLookup(items);
  expect(reads).toBe(0);

  lookup('$a');
  lookup('$a');
  expect(reads).toBe(1);
});

test('a hidden event names its sender, as v1 does', () => {
  const t: Translate = (key, values) => `${key}:${JSON.stringify(values)}`;
  const hidden = (eventType: string, content: unknown): ResolvedItem => ({
    ...item({ kind: 'hidden_event', event_type: eventType, content, redacts: null }),
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
  const reaction = (content: unknown): ResolvedItem => ({
    ...item({ kind: 'hidden_event', event_type: 'm.reaction', content, redacts: null }),
    sender: '@alice:example.org',
    sender_name: 'Alice',
  });

  expect(stateEventText(reaction({ 'm.relates_to': { key: '👍' } }), t)).toBe(
    'timeline.hiddenReaction:{"user":"Alice","key":"👍"}'
  );
  expect(stateEventText(reaction({ shortcode: 'party', 'm.relates_to': { key: 'x' } }), t)).toBe(
    'timeline.hiddenReaction:{"user":"Alice","key":":party:"}'
  );
  expect(
    stateEventText(
      reaction({ shortcode: ':party:', 'm.relates_to': { key: 'mxc://example.org/party' } }),
      t
    )
  ).toBe('timeline.hiddenReaction:{"user":"Alice","key":":party:"}');
  expect(stateEventText(reaction({ shortcode: '::', 'm.relates_to': { key: '👍' } }), t)).toBe(
    'timeline.hiddenReaction:{"user":"Alice","key":"👍"}'
  );
  expect(stateEventText(reaction({ 'm.relates_to': {} }), t)).toBe(
    'timeline.hiddenEvent:{"user":"Alice","type":"m.reaction"}'
  );
});

test('a cleared avatar is not the same sentence as a replaced one', () => {
  const avatarChange = (newUrl: string | null): ResolvedItem =>
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
