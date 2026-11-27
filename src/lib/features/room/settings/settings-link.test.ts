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

test.each([
  ['sounds', 'notifications'],
  ['sync', 'account'],
  ['time', 'language'],
])('a link to the merged %s page opens %s', (legacy, section) => {
  expect(parseSettingsLink(`${APP}/settings/${legacy}`, APP)).toEqual({ section });
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

test.each([
  ['tauri://localhost', 'tauri://localhost'],
  ['sable-app://app', 'sable-app://app'],
  ['http://tauri.localhost', 'http://tauri.localhost'],
  ['https://tauri.localhost', 'https://tauri.localhost'],
])('reads a link copied from the %s app', (appOrigin, linkOrigin) => {
  const path = '/settings/notifications?focus=favicon-for-mentions-only';
  const expected = { section: 'notifications', focus: 'favicon-for-mentions-only' };
  expect(parseSettingsLink(`${linkOrigin}${path}`, appOrigin)).toEqual(expected);
  expect(parseSettingsLink(`${linkOrigin}${path}`, APP)).toBeNull();
  expect(parseSettingsLink(`${linkOrigin}${path}&moe.sable.client.action=settings`, APP)).toEqual(
    expected
  );
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
  'tauri://evil.example/settings/timeline?moe.sable.client.action=settings',
  'sable-app://evil.example/settings/appearance?moe.sable.client.action=settings',
  'sable-app://app:1234/settings/appearance?moe.sable.client.action=settings',
])('rejects %s', (href) => {
  expect(parseSettingsLink(href, APP)).toBeNull();
});

test('a heading that moved to another category opens there', () => {
  expect(parseSettingsLink(`${APP}/settings/timeline?focus=message-search`, APP)).toEqual({
    section: 'search',
    focus: 'message-search',
  });
});

test('a focus id that is not a setting is kept for the heading it may name', () => {
  expect(parseSettingsLink(`${APP}/settings/timeline?focus=room-events`, APP)).toEqual({
    section: 'timeline',
    focus: 'room-events',
  });
  expect(parseSettingsLink(`${APP}/settings/about?focus=about-homeserver`, APP)).toEqual({
    section: 'about',
    focus: 'about-homeserver',
  });
});

test.each([
  [APP, APP],
  ['http://localhost:3000', 'http://localhost:3000'],
  ['tauri://localhost', 'https://app.sable.moe'],
  ['sable-app://app', 'https://app.sable.moe'],
  ['http://tauri.localhost', 'https://app.sable.moe'],
  ['https://tauri.localhost', 'https://app.sable.moe'],
])('builds a shareable settings link from %s', (origin, linkOrigin) => {
  const href = buildSettingsLink(origin, 'timeline', 'hide-read-receipts');
  expect(href).toBe(
    `${linkOrigin}/settings/timeline?focus=hide-read-receipts&moe.sable.client.action=settings`
  );
  expect(parseSettingsLink(href, 'https://elsewhere.example')).toEqual({
    section: 'timeline',
    focus: 'hide-read-receipts',
  });
});

test('reads an existing Electron font settings link', () => {
  expect(
    parseSettingsLink(
      'sable-app://app/settings/appearance?focus=font-family&moe.sable.client.action=settings',
      APP
    )
  ).toEqual({ section: 'appearance', focus: 'font-family' });
});
