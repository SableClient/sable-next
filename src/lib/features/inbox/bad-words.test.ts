import { expect, test } from 'vitest';

import { hasBadWords } from './bad-words';

test('a listed word matches on word boundaries, whatever the case', () => {
  expect(hasBadWords('Free SHIT here')).toBe(true);
  expect(hasBadWords('come_torture_room')).toBe(true);
  expect(hasBadWords('Classic literature')).toBe(false);
  expect(hasBadWords('Assessment day')).toBe(false);
});

test('any of several fields can match, and missing ones are skipped', () => {
  expect(hasBadWords(null, undefined, 'Book club')).toBe(false);
  expect(hasBadWords('Book club', null, '@t0rture:example.org')).toBe(true);
});

test('a listed word with regex metacharacters matches literally', () => {
  expect(hasBadWords('what a b!tch')).toBe(true);
  expect(hasBadWords('ass-fucker')).toBe(true);
});
