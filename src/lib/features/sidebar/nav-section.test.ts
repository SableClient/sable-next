import { expect, test } from 'vitest';

import { navSectionKind } from './nav-section.js';

test('each route prefix names its own section', () => {
  expect(navSectionKind('/direct')).toBe('direct');
  expect(navSectionKind('/direct/!room:example.org')).toBe('direct');
  expect(navSectionKind('/rooms')).toBe('unspaced');
  expect(navSectionKind('/space/!s:example.org')).toBe('space');
  expect(navSectionKind('/home')).toBe('home');
  expect(navSectionKind('/anything-else')).toBe('home');
});
