import { expect, test } from 'vitest';

import { preferences } from './preferences.svelte.js';
import { composerSeparatorCount, sanitize, withComposerSeparatorCount } from './definitions.js';

test('keeps a saved call input mode and rejects unknown values', () => {
  expect(sanitize({ callInputMode: 'push-to-talk' }, preferences).callInputMode).toBe(
    'push-to-talk'
  );
  expect(sanitize({ callInputMode: 'unknown' }, preferences).callInputMode).toBe('voice-activity');
});

test.each([
  [true, 'on'],
  [false, 'off'],
] as const)('migrates media loading %s as %s', (stored, expected) => {
  expect(sanitize({ mediaAutoLoad: stored }, preferences).mediaAutoLoad).toBe(expected);
});

test('keeps the cached loading animal', () => {
  expect(sanitize({ loadingAnimal: 'otter' }, preferences).loadingAnimal).toBe('otter');
});

test('keeps quick CSS', () => {
  expect(sanitize({ quickCss: '.btn { color: red; }' }, preferences).quickCss).toBe(
    '.btn { color: red; }'
  );
});

test.each(['fontFamily', 'fontFamilyMono'] as const)(
  'keeps the saved %s across a reload',
  (key) => {
    expect(sanitize({ [key]: 'IBM Plex Mono' }, { ...preferences, [key]: '' })[key]).toBe(
      'IBM Plex Mono'
    );
  }
);

test('keeps the search crawler preference', () => {
  expect(sanitize({ searchCrawler: false }, preferences).searchCrawler).toBe(false);
});

test('defaults to unmetered crawling and keeps the saved preference', () => {
  expect(sanitize({}, preferences).searchUnmeteredOnly).toBe(true);
  expect(sanitize({ searchUnmeteredOnly: false }, preferences).searchUnmeteredOnly).toBe(false);
});

test('shares directly between devices by default', () => {
  const defaults = sanitize({}, preferences);
  expect(defaults.searchSharing).toBe(true);
  expect(sanitize({ searchSharing: false }, preferences).searchSharing).toBe(false);
});

test('keeps a notification volume inside its range', () => {
  expect(sanitize({ soundsNotificationVolume: 0.4 }, preferences).soundsNotificationVolume).toBe(
    0.4
  );
  expect(sanitize({ soundsNotificationVolume: 3 }, preferences).soundsNotificationVolume).toBe(2);
  expect(sanitize({ soundsNotificationVolume: 'loud' }, preferences).soundsNotificationVolume).toBe(
    preferences.soundsNotificationVolume
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

test('threads default to full conversations and keep a saved panel choice', () => {
  expect(sanitize({}, preferences).threadPresentation).toBe('timeline');
  expect(sanitize({ threadPresentation: 'panel' }, preferences).threadPresentation).toBe('panel');
  expect(sanitize({ threadPresentation: 'unknown' }, preferences).threadPresentation).toBe(
    'timeline'
  );
});

test('reads a stored boolean enterForNewline as its enum equivalent', () => {
  expect(sanitize({ enterForNewline: true }, preferences).enterForNewline).toBe('newline');
  expect(sanitize({ enterForNewline: false }, preferences).enterForNewline).toBe('adaptive');
  expect(sanitize({ enterForNewline: 'send' }, preferences).enterForNewline).toBe('send');
});

test('normalizes a legacy separator and keeps multiple separators', () => {
  expect(
    sanitize(
      { composerButtonOrder: ['gif', 'separator', 'sticker', 'emoticon', 'persona', 'format'] },
      preferences
    ).composerButtonOrder
  ).toEqual(['gif', 'separator:0', 'sticker', 'emoticon', 'persona', 'format']);

  expect(
    sanitize(
      {
        composerButtonOrder: [
          'gif',
          'separator:0',
          'sticker',
          'separator:1',
          'emoticon',
          'persona',
          'format',
        ],
      },
      preferences
    ).composerButtonOrder
  ).toEqual(['gif', 'separator:0', 'sticker', 'separator:1', 'emoticon', 'persona', 'format']);
});

test('adds or removes one separator in place without rebuilding order', () => {
  const base = ['gif', 'sticker', 'emoticon', 'separator:0', 'persona', 'format'] as const;
  expect(composerSeparatorCount(withComposerSeparatorCount(base, 0))).toBe(0);
  expect(withComposerSeparatorCount(base, 0)).toEqual([
    'gif',
    'sticker',
    'emoticon',
    'persona',
    'format',
  ]);
  expect(withComposerSeparatorCount(base, 1)).toEqual([
    'gif',
    'sticker',
    'emoticon',
    'separator:0',
    'persona',
    'format',
  ]);
  expect(withComposerSeparatorCount(base, 3)).toEqual([
    'gif',
    'sticker',
    'emoticon',
    'separator:0',
    'separator:1',
    'separator:2',
    'persona',
    'format',
  ]);
  const custom = [
    'gif',
    'separator:0',
    'sticker',
    'separator:1',
    'emoticon',
    'persona',
    'format',
  ] as const;
  expect(withComposerSeparatorCount(custom, 1)).toEqual([
    'gif',
    'separator:0',
    'sticker',
    'emoticon',
    'persona',
    'format',
  ]);
  expect(withComposerSeparatorCount(custom, 3)).toEqual([
    'gif',
    'separator:0',
    'sticker',
    'separator:1',
    'separator:2',
    'emoticon',
    'persona',
    'format',
  ]);
  expect(
    withComposerSeparatorCount(['format', 'gif', 'sticker', 'emoticon', 'persona'], 1)
  ).toEqual(['format', 'gif', 'sticker', 'emoticon', 'separator:0', 'persona']);
});
