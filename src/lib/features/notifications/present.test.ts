// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import type { NotificationView } from '#src/generated/NotificationView';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

import { preferences } from '#lib/settings/preferences.svelte.js';

import { body, canPresent, tag, title } from './present';

function view(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    user_id: '@me:example.org',
    room_id: '!room:example.org',
    event_id: '$event:example.org',
    room_name: 'Design crew',
    room_avatar_url: null,
    is_direct: false,
    sender: '@ada:example.org',
    sender_name: 'Ada',
    sender_avatar_url: null,
    body: 'shipped the patch',
    mention: false,
    noisy: true,
    ...overrides,
  };
}

beforeEach(() => {
  preferences.notificationContent = true;
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

test('one alert per room and account, so a busy room replaces its own', () => {
  expect(tag(view())).toBe('@me:example.org !room:example.org');
  expect(tag(view({ room_id: '!other:example.org' }))).not.toBe(tag(view()));
});

test('the browser presents, and a native shell does not use this path', () => {
  // happy-dom has no Notification of its own.
  vi.stubGlobal('Notification', { permission: 'granted' });
  expect(canPresent()).toBe(true);

  vi.stubGlobal('Notification', undefined);
  expect(canPresent()).toBe(false);
});
