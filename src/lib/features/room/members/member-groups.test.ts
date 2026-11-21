import { expect, test, vi } from 'vitest';

import type { MembershipChangeView, TimelineItemView } from '#src/generated/protocol';

import {
  groupTimelineRuns,
  memberGroupSegments,
  memberGroupSummary,
  type MemberGroupToken,
} from './member-groups';

function member(
  user: string,
  change: MembershipChangeView,
  extra: Partial<TimelineItemView> = {}
): TimelineItemView {
  return {
    id: `${user}-${change}`,
    event_id: `$${user}-${change}`,
    sender: `@${user}:x`,
    sender_name: null,
    reactions: [],
    read_by: [],
    read_timestamps: {},
    content: {
      kind: 'membership',
      user_id: `@${user}:x`,
      change,
      display_name: user.toUpperCase(),
      reason: null,
    },
    ...extra,
  } as TimelineItemView;
}

function rename(user: string, to: string): TimelineItemView {
  return member(user, 'joined', {
    id: `${user}-${to}`,
    event_id: `$${user}-${to}`,
    sender_name: to,
    content: {
      kind: 'profile_change',
      user_id: `@${user}:x`,
      display_name: { old: user, new: to },
      avatar: null,
    },
  });
}

const message = {
  id: 'message',
  event_id: '$message',
  reactions: [],
  read_by: [],
  read_timestamps: {},
  content: { kind: 'message', body: 'hi', html: 'hi', msgtype: 'text', edited: false },
} as unknown as TimelineItemView;

const t = (key: string, values?: Record<string, unknown>): string => {
  const templates: Record<string, string> = {
    'timeline.memberGroup.joined': '{{users}} joined',
    'timeline.memberGroup.left': '{{users}} left',
    'timeline.memberGroup.invited': '{{users}} invited',
    'timeline.memberGroup.name': '{{users}} changed their name',
  };
  return (templates[key] ?? key).replace('{{users}}', String(values?.users));
};

test('each sentence is pluralised by the people in its own segment', () => {
  const translate = vi.fn((key: string) => key);
  const segments = memberGroupSegments([
    member('a', 'joined'),
    member('b', 'joined'),
    member('a', 'left'),
  ]);
  memberGroupSummary(segments, translate, 'en');
  expect(translate).toHaveBeenCalledWith(
    'timeline.memberGroup.joined',
    expect.objectContaining({ count: 2 })
  );
  expect(translate).toHaveBeenCalledWith(
    'timeline.memberGroup.left',
    expect.objectContaining({ count: 1 })
  );
});

function text(tokens: MemberGroupToken[]): string {
  return tokens
    .map((token) => {
      if (token.kind === 'text') return token.text;
      if (token.kind === 'user') return `[${token.name}]`;
      return `<${String(token.count)} others>`;
    })
    .join('');
}

test('a run of two or more member events becomes one unit keyed on its newest event', () => {
  const items = [message, member('a', 'joined'), member('b', 'joined'), message];
  const units = groupTimelineRuns(items);

  expect(units.map((unit) => unit.index)).toEqual([0, 2, 3]);
  expect(units[1].item).toBe(items[2]);
  expect(units[1].group).toEqual([items[1], items[2]]);
  expect(units[0].group).toBeNull();
});

test('receipts on a collapsed group move to the last event before it', () => {
  const read = { ...message, read_by: ['@bob:x'], read_timestamps: { '@bob:x': 1 } };
  const items = [
    read,
    member('a', 'joined', { read_by: ['@carol:x'], read_timestamps: { '@carol:x': 2 } }),
    member('b', 'joined'),
  ];
  const [first] = groupTimelineRuns(items);

  expect(first.item.read_by).toEqual(['@bob:x', '@carol:x']);
  expect(first.item.read_timestamps).toEqual({ '@bob:x': 1, '@carol:x': 2 });
});

test('a lone member event, a moderated one or reactions stay their own row', () => {
  const items = [
    member('a', 'joined'),
    member('b', 'banned'),
    member('c', 'joined', { reactions: [{ key: '👍', senders: ['@a:x'] }] as never }),
  ];

  expect(groupTimelineRuns(items).every((unit) => unit.group === null)).toBe(true);
});

test('membership events with reasons are grouped', () => {
  const items = [
    member('a', 'left', {
      content: {
        kind: 'membership',
        user_id: '@a:x',
        change: 'left',
        display_name: 'A',
        reason: 'IRC quit',
      },
    }),
    member('b', 'joined'),
  ];

  expect(groupTimelineRuns(items)).toEqual([
    { item: items[1], index: 1, group: items, kind: 'members' },
  ]);
});

test('lists up to three names and folds the rest into a count', () => {
  const few = memberGroupSegments([member('a', 'joined'), member('b', 'joined')]);
  expect(text(memberGroupSummary(few, t, 'en'))).toBe('[A] and [B] joined');

  const many = memberGroupSegments(['a', 'b', 'c', 'd', 'e'].map((user) => member(user, 'joined')));
  const tokens = memberGroupSummary(many, t, 'en');
  expect(text(tokens)).toBe('[A], [B], and <3 others> joined');
  expect(tokens.find((token) => token.kind === 'others')).toEqual({
    kind: 'others',
    count: 3,
    segment: 0,
  });
});

test('each kind of change gets its own clause, and a user is named once per clause', () => {
  const segments = memberGroupSegments([
    member('a', 'joined'),
    member('a', 'left'),
    member('b', 'invitation_accepted'),
    member('a', 'joined', { id: 'again', event_id: '$again' }),
  ]);

  expect(segments.map((segment) => segment.category)).toEqual(['joined', 'left']);
  expect(text(memberGroupSummary(segments, t, 'en'))).toBe('[A] and [B] joined and [A] left');
});

test('name changes collapse with adjacent member events', () => {
  const items = [rename('a', 'A1'), rename('a', 'A2'), member('b', 'joined'), rename('c', 'C')];
  const units = groupTimelineRuns(items);

  expect(units).toEqual([{ item: items[3], index: 3, group: items, kind: 'members' }]);
  expect(text(memberGroupSummary(memberGroupSegments(items), t, 'en'))).toBe(
    '[A1] and [C] changed their name and [B] joined'
  );
});

test('an invitation collapses with the join that answers it', () => {
  const items = [member('a', 'invited'), member('a', 'invitation_accepted'), member('b', 'left')];

  expect(groupTimelineRuns(items)).toEqual([
    { item: items[2], index: 2, group: items, kind: 'members' },
  ]);
  expect(text(memberGroupSummary(memberGroupSegments(items), t, 'en'))).toBe(
    '[A] invited, [A] joined, and [B] left'
  );
});

function beforeJoin(id: string, extra: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id,
    event_id: `$${id}`,
    sender: '@alice:x',
    reactions: [],
    read_by: [],
    read_timestamps: {},
    thread_summary: null,
    thread_root: null,
    content: { kind: 'unable_to_decrypt', reason: 'sent_before_we_joined' },
    ...extra,
  } as unknown as TimelineItemView;
}

test('messages sent before the join fold into one unit keyed on the newest', () => {
  const items = [message, beforeJoin('a'), beforeJoin('b'), beforeJoin('c'), message];
  const units = groupTimelineRuns(items);

  expect(units.map((unit) => unit.kind)).toEqual([null, 'before_join', null]);
  expect(units[1]).toMatchObject({ item: items[3], index: 3, group: items.slice(1, 4) });
});

test('a lone message from before the join keeps its own row', () => {
  expect(
    groupTimelineRuns([message, beforeJoin('a'), message]).every((unit) => unit.group === null)
  ).toBe(true);
});

test('member events and messages from before the join never share a run', () => {
  const items = [member('a', 'joined'), member('b', 'joined'), beforeJoin('c'), beforeJoin('d')];

  expect(groupTimelineRuns(items).map((unit) => [unit.kind, unit.group?.length])).toEqual([
    ['members', 2],
    ['before_join', 2],
  ]);
});

test('messages with reactions or threads stay out of a run from before the join', () => {
  const items = [
    beforeJoin('a'),
    beforeJoin('b', { reactions: [{ key: '👍' }] } as unknown as Partial<TimelineItemView>),
    beforeJoin('c', { thread_root: '$root' }),
    beforeJoin('d'),
  ];

  expect(groupTimelineRuns(items).every((unit) => unit.group === null)).toBe(true);
});

test('other undecryptable messages are not folded', () => {
  const waiting = (id: string) =>
    beforeJoin(id, {
      content: { kind: 'unable_to_decrypt', reason: 'unknown' },
    } as Partial<TimelineItemView>);

  expect(groupTimelineRuns([waiting('a'), waiting('b')]).every((unit) => unit.group === null)).toBe(
    true
  );
});
