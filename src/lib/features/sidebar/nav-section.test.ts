import { expect, test } from 'vitest';

import { navSectionKind, navSectionLabels } from './nav-section.js';

test('each route prefix names its own section', () => {
  expect(navSectionKind('/direct')).toBe('direct');
  expect(navSectionKind('/direct/!room:example.org')).toBe('direct');
  expect(navSectionKind('/rooms')).toBe('unspaced');
  expect(navSectionKind('/space/!s:example.org')).toBe('space');
  expect(navSectionKind('/home')).toBe('home');
  expect(navSectionKind('/anything-else')).toBe('home');
});

test('only the direct section renames the list', () => {
  expect(navSectionLabels('direct').list).toBe('nav.chats');
  for (const kind of ['unspaced', 'space', 'home'] as const) {
    expect(navSectionLabels(kind).list).toBe('nav.rooms');
  }
});

test('direct and unspaced each explain their own emptiness', () => {
  expect(navSectionLabels('direct').empty).toBe('nav.chatsEmpty');
  expect(navSectionLabels('unspaced').empty).toBe('nav.unspacedEmpty');
  expect(navSectionLabels('space').empty).toBe('nav.roomsUnavailable');
  expect(navSectionLabels('home').empty).toBe('nav.roomsUnavailable');
});

test('every section carries a title key', () => {
  expect(navSectionLabels('direct').title).toBe('nav.direct');
  expect(navSectionLabels('unspaced').title).toBe('nav.unspaced');
  expect(navSectionLabels('space').title).toBe('nav.space');
  expect(navSectionLabels('home').title).toBe('nav.home');
});
