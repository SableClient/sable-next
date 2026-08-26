import { expect, test } from 'vitest';

import type { MemberView } from '#src/generated/MemberView';

import { reactionSummary } from './reaction-summary.js';

const members = [
  { user_id: '@a:x', display_name: 'Ana', avatar_url: null },
  { user_id: '@b:x', display_name: 'Bo', avatar_url: null },
  { user_id: '@c:x', display_name: 'Cy', avatar_url: null },
  { user_id: '@d:x', display_name: 'Dee', avatar_url: null },
  { user_id: '@e:x', display_name: 'Eve', avatar_url: null },
] as unknown as MemberView[];

const t = (key: string, params: Record<string, unknown> = {}): string =>
  `${key}(${Object.entries(params)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('|')})`;

test('one sender is named directly', () => {
  expect(reactionSummary(['@a:x'], '👍', members, t)).toBe(
    'timeline.reactedWith(people=Ana|key=👍)'
  );
});

test('two and three senders each get their own phrasing', () => {
  expect(reactionSummary(['@a:x', '@b:x'], '👍', members, t)).toContain(
    'timeline.reactionPeopleTwo(first=Ana|second=Bo)'
  );
  expect(reactionSummary(['@a:x', '@b:x', '@c:x'], '👍', members, t)).toContain(
    'timeline.reactionPeopleThree(first=Ana|second=Bo|third=Cy)'
  );
});

test('beyond three, the rest are counted', () => {
  expect(reactionSummary(['@a:x', '@b:x', '@c:x', '@d:x', '@e:x'], '👍', members, t)).toContain(
    'timeline.reactionPeopleMany(names=Ana, Bo, Cy|count=2)'
  );
});

test('an unknown sender falls back to their user id', () => {
  expect(reactionSummary(['@nobody:x'], '👍', members, t)).toContain('people=@nobody:x');
});
