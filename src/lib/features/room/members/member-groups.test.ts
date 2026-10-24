import { expect, test } from 'vitest';

import type { TimelineMemberCategoryView, TimelineSegmentView } from '#src/generated/protocol';

import { memberGroupSummary, type MemberGroupToken } from './member-groups';

function segment(category: TimelineMemberCategoryView, ...users: string[]): TimelineSegmentView {
  return {
    category,
    users: users.map((user) => ({ user_id: `@${user}:x`, name: user.toUpperCase() })),
  };
}

const t = (key: string, values?: Record<string, unknown>): string => {
  const templates: Record<string, string> = {
    'timeline.memberGroup.joined': '{{users}} joined',
    'timeline.memberGroup.left': '{{users}} left',
    'timeline.memberGroup.invited': '{{users}} invited',
    'timeline.memberGroup.name': '{{users}} changed their name',
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

test('lists up to three names and folds the rest into a count', () => {
  const few = [segment('joined', 'a', 'b')];
  expect(text(memberGroupSummary(few, t, 'en'))).toBe('[A] and [B] joined');

  const many = [segment('joined', 'a', 'b', 'c', 'd', 'e')];
  const tokens = memberGroupSummary(many, t, 'en');
  expect(text(tokens)).toBe('[A], [B], and <3 others> joined');
  expect(tokens.find((token) => token.kind === 'others')).toEqual({
    kind: 'others',
    count: 3,
    segment: 0,
  });
});

test('each kind of change gets its own clause', () => {
  const segments = [segment('joined', 'a', 'b'), segment('left', 'a')];
  expect(text(memberGroupSummary(segments, t, 'en'))).toBe('[A] and [B] joined and [A] left');
});

test('name changes and invitations read as their own clauses', () => {
  const names = [segment('name', 'a', 'c'), segment('joined', 'b')];
  expect(text(memberGroupSummary(names, t, 'en'))).toBe(
    '[A] and [C] changed their name and [B] joined'
  );
  const invited = [segment('invited', 'a'), segment('joined', 'a'), segment('left', 'b')];
  expect(text(memberGroupSummary(invited, t, 'en'))).toBe('[A] invited, [A] joined, and [B] left');
});
