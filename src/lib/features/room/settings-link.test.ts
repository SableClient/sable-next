import { expect, test } from 'vitest';

import { buildSettingsLink, parseSettingsLink } from './settings-link';

const APP = 'https://sable.example';

test.each([
  ['https://sable.example/settings/timeline', { section: 'timeline' }],
  ['https://sable.example/settings/timeline/', { section: 'timeline' }],
  [
    'https://sable.example/settings/timeline?focus=hide-read-receipts',
    { section: 'timeline', focus: 'hide-read-receipts' },
  ],
  ['https://sable.example/settings/devices', { section: 'devices' }],
])('parses same-origin %s', (href, expected) => {
  expect(parseSettingsLink(href, APP)).toEqual(expected);
});

test('another deployment needs the action marker', () => {
  const href = 'https://other.example/settings/timeline';
  expect(parseSettingsLink(href, APP)).toBeNull();
  expect(parseSettingsLink(`${href}?moe.sable.client.action=settings`, APP)).toEqual({
    section: 'timeline',
  });
});

test("reads v1's hash routing", () => {
  expect(
    parseSettingsLink(
      'https://v1.example/#/settings/privacy?focus=send-read-receipts&moe.sable.client.action=settings',
      APP
    )
  ).toEqual({ section: 'privacy', focus: 'send-read-receipts' });
});

test('a focus id that moved sections resolves to the section that owns it', () => {
  expect(
    parseSettingsLink('https://sable.example/settings/appearance?focus=hide-read-receipts', APP)
  ).toEqual({ section: 'timeline', focus: 'hide-read-receipts' });
});

test.each([
  'https://sable.example/rooms/timeline',
  'https://sable.example/settings/not-a-section',
  'https://sable.example/settings/timeline?focus=<script>',
  'https://sable.example/settings/timeline?focus=a&focus=b',
  'https://sable.example/settings/timeline?moe.sable.client.action=logout',
  'javascript:alert(1)/settings/timeline',
])('rejects %s', (href) => {
  expect(parseSettingsLink(href, APP)).toBeNull();
});

test('an unknown focus id still opens the section', () => {
  expect(parseSettingsLink('https://sable.example/settings/timeline?focus=long-gone', APP)).toEqual(
    { section: 'timeline' }
  );
});

test('builds a marked, shareable link that parses back', () => {
  const href = buildSettingsLink(APP, 'timeline', 'hide-read-receipts');
  expect(href).toContain('moe.sable.client.action=settings');
  expect(parseSettingsLink(href, 'https://elsewhere.example')).toEqual({
    section: 'timeline',
    focus: 'hide-read-receipts',
  });
});
