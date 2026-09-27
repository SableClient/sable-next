import { expect, test } from 'vitest';

import { readAlwaysListedFrom } from './member-list.svelte.js';

test.each([
  [{ always_listed_from: 50 }, 50],
  [{ always_listed_from: 0 }, 0],
  [{ always_listed_from: 12.5 }, null],
  [{ always_listed_from: '50' }, null],
  [{}, null],
  [null, null],
])('reads the always-listed level from %j', (content, level) => {
  expect(readAlwaysListedFrom(content)).toBe(level);
});
