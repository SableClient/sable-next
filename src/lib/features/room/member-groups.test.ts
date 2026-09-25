import { expect, test } from 'vitest';

import type { MembershipChangeView, TimelineItemView } from '#src/generated/protocol';

import {
  groupMemberEvents,
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

const message = {
  id: 'message',
  event_id: '$message',
  reactions: [],
  content: { kind: 'message', body: 'hi', html: 'hi', emote: false, notice: false, edited: false },
} as unknown as TimelineItemView;

const t = (key: string, values?: Record<string, unknown>): string => {
  const templates: Record<string, string> = {
    'timeline.memberGroup.joined': '{{users}} joined',
    'timeline.memberGroup.left': '{{users}} left',
  };
  return (templates[key] ?? key).replace('{{users}}', String(values?.users));
};

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
  const units = groupMemberEvents(items);

  expect(units.map((unit) => unit.index)).toEqual([0, 2, 3]);
  expect(units[1].item).toBe(items[2]);
  expect(units[1].group).toEqual([items[1], items[2]]);
  expect(units[0].group).toBeNull();
});

test('a lone member event, a moderated one, a reason or reactions stay their own row', () => {
  const items = [
    member('a', 'joined'),
    member('b', 'banned'),
    member('c', 'left', {
      content: {
        kind: 'membership',
        user_id: '@c:x',
        change: 'left',
        display_name: null,
        reason: 'bye',
      },
    }),
    member('d', 'joined', { reactions: [{ key: '👍', senders: ['@a:x'] }] as never }),
  ];

  expect(groupMemberEvents(items).every((unit) => unit.group === null)).toBe(true);
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
