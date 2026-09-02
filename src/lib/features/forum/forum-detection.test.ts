import { expect, test } from 'vitest';

import { isForumRoomType } from './forum-detection';

test('a create event with the forum type is a forum room', () => {
  expect(isForumRoomType({ type: 'pl.chrome.forum' })).toBe(true);
});

test('a create event with another type is not a forum room', () => {
  expect(isForumRoomType({ type: 'm.space' })).toBe(false);
});

test('a create event with no type is not a forum room', () => {
  expect(isForumRoomType({})).toBe(false);
});

test('a missing or malformed create content is not a forum room', () => {
  expect(isForumRoomType(null)).toBe(false);
  expect(isForumRoomType(undefined)).toBe(false);
  expect(isForumRoomType('pl.chrome.forum')).toBe(false);
});
