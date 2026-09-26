// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { parseRecentReactions } from './recents.svelte.js';

test('recent reactions that repeat an emoji keep the first entry', () => {
  expect(parseRecentReactions([['👍', 3], { emoji: '🎉', total: 1 }, ['👍', 9]])).toEqual([
    { emoji: '👍', total: 3 },
    { emoji: '🎉', total: 1 },
  ]);
});
