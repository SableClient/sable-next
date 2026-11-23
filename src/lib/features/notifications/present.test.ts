// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import type { NotificationView } from '#src/generated/protocol';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

import { preferences } from '#lib/settings/preferences.svelte.js';

import { body, bodySegments, title } from './present';

function view(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    user_id: '@me:example.org',
    room_id: '!room:example.org',
    event_id: '$event:example.org',
    room_name: 'Design crew',
    room_avatar_url: null,
    is_direct: false,
    encrypted: false,
    sender: '@ada:example.org',
    sender_name: 'Ada',
    sender_avatar_url: null,
    body: 'shipped the patch',
    emotes: [],
    mention: false,
    noisy: true,
    ...overrides,
  };
}

beforeEach(() => {
  preferences.notificationContent = true;
  preferences.notificationEncryptedContent = false;
});

test('a room names the sender, a chat does not', () => {
  expect(title(view())).toBe('Design crew');
  expect(body(view())).toBe('Ada: shipped the patch');
  expect(body(view({ is_direct: true, room_name: 'Ada' }))).toBe('shipped the patch');
});

test('an unnamed sender falls back to the id', () => {
  expect(body(view({ sender_name: null }))).toBe('@ada:example.org: shipped the patch');
});

test('content stays out of the alert when the reader asked it to', () => {
  preferences.notificationContent = false;

  expect(body(view())).toBe('New message from Ada');
  expect(body(view({ is_direct: true }))).toBe('New message');
});

test('an encrypted room keeps its content back until it is allowed', () => {
  expect(body(view({ encrypted: true }))).toBe('New message from Ada');

  preferences.notificationEncryptedContent = true;
  expect(body(view({ encrypted: true }))).toBe('Ada: shipped the patch');
});

test('custom emotes show only with the content and never in the sender name', () => {
  const blob = { alt: ':blob:', source: 'mxc://example.org/blob' };
  const emoted = view({ sender_name: ':blob:', body: 'hi :blob:', emotes: [blob] });

  expect(bodySegments(emoted)).toEqual([':blob:: ', 'hi ', blob]);
  expect(bodySegments({ ...emoted, is_direct: true })).toEqual(['hi ', blob]);

  preferences.notificationContent = false;
  expect(bodySegments(emoted)).toEqual(['New message from :blob:']);
});
