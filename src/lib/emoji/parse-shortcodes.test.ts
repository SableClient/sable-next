import { expect, test } from 'vitest';

import { parseShortcodes } from './parse-shortcodes.js';

test('a store holding something else does not break the picker', () => {
  expect(parseShortcodes({ not: 'an array' })).toEqual([]);
  expect(parseShortcodes(['ok', 3, null])).toEqual(['ok']);
});

test('a synced list that repeats a shortcode keeps its first place', () => {
  expect(parseShortcodes(['party', 'blobwave', 'party', 7])).toEqual(['party', 'blobwave']);
});
