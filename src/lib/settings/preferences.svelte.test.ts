import { expect, test } from 'vitest';

import { preferences, sanitize } from './preferences.svelte.js';

test('keeps the cached loading animal', () => {
  expect(sanitize({ loadingAnimal: 'otter' }, preferences).loadingAnimal).toBe('otter');
});

test('keeps quick CSS', () => {
  expect(sanitize({ quickCss: '.btn { color: red; }' }, preferences).quickCss).toBe(
    '.btn { color: red; }'
  );
});

test('keeps the search crawler preference', () => {
  expect(sanitize({ searchCrawler: false }, preferences).searchCrawler).toBe(false);
});

test('defaults to unmetered crawling and keeps the saved preference', () => {
  expect(sanitize({}, preferences).searchUnmeteredOnly).toBe(true);
  expect(sanitize({ searchUnmeteredOnly: false }, preferences).searchUnmeteredOnly).toBe(false);
});

test('keeps a notification volume inside its range', () => {
  expect(sanitize({ notificationSoundVolume: 0.4 }, preferences).notificationSoundVolume).toBe(0.4);
  expect(sanitize({ notificationSoundVolume: 3 }, preferences).notificationSoundVolume).toBe(1);
  expect(sanitize({ notificationSoundVolume: 'loud' }, preferences).notificationSoundVolume).toBe(
    preferences.notificationSoundVolume
  );
});

test('keeps a resized banner height across a reload', () => {
  expect(sanitize({ roomBannerHeight: 320 }, preferences).roomBannerHeight).toBe(320);
  expect(sanitize({ roomBannerHeight: 9000 }, preferences).roomBannerHeight).toBe(500);
});

test('an older button order gains the persona and format buttons at the end', () => {
  expect(
    sanitize({ composerButtonOrder: ['emoticon', 'gif', 'sticker'] }, preferences)
      .composerButtonOrder
  ).toEqual(['emoticon', 'gif', 'sticker', 'persona', 'format']);
});
