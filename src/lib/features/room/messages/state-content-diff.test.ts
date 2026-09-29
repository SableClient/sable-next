import { expect, test } from 'vitest';

import { stateContentDiff, stateValueText } from './state-content-diff';

test('a power level change names the user whose level moved', () => {
  expect(
    stateContentDiff(
      { users: { '@a:b': 100, '@c:d': 50 }, ban: 50 },
      { users: { '@a:b': 100, '@c:d': 100 }, ban: 50 }
    )
  ).toEqual([{ path: ['users', '@c:d'], before: 50, after: 100 }]);
});

test('added and removed keys carry an undefined side', () => {
  expect(stateContentDiff({ join_rule: 'invite' }, { join_rule: 'public', guest: true })).toEqual([
    { path: ['join_rule'], before: 'invite', after: 'public' },
    { path: ['guest'], before: undefined, after: true },
  ]);
  expect(stateContentDiff({ users: { '@a:b': 50 } }, {})).toEqual([
    { path: ['users', '@a:b'], before: 50, after: undefined },
  ]);
});

test('arrays show only added and removed items', () => {
  expect(stateContentDiff({ allow: ['*'] }, { allow: ['*'] })).toEqual([]);
  expect(stateContentDiff({ allow: ['*'] }, { allow: ['*', 'x'] })).toEqual([
    { path: ['allow', '1'], before: undefined, after: 'x' },
  ]);
  expect(stateContentDiff({ allow: ['a', 'b', 'c'] }, { allow: ['a', 'c'] })).toEqual([
    { path: ['allow', '1'], before: 'b', after: undefined },
  ]);
  expect(stateContentDiff({ allow: ['a', 'b'] }, { allow: ['a', 'c'] })).toEqual([
    { path: ['allow', '1'], before: 'b', after: undefined },
    { path: ['allow', '1'], before: undefined, after: 'c' },
  ]);
});

test('array reordering shows moved items without unchanged items', () => {
  expect(stateContentDiff({ allow: ['a', 'b', 'c'] }, { allow: ['c', 'a', 'b'] })).toEqual([
    { path: ['allow', '0'], before: undefined, after: 'c' },
    { path: ['allow', '3'], before: 'c', after: undefined },
  ]);
});

test('no previous content lists every field as added', () => {
  expect(stateContentDiff(null, { algorithm: 'm.megolm.v1.aes-sha2' })).toEqual([
    { path: ['algorithm'], before: undefined, after: 'm.megolm.v1.aes-sha2' },
  ]);
});

test('values render as JSON', () => {
  expect(stateValueText('public')).toBe('"public"');
  expect(stateValueText(['*'])).toBe('["*"]');
  expect(stateValueText(null)).toBe('null');
});
