// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ playNotificationSound: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'linux' }));
vi.mock('#lib/platform/native-notifications.js', () => ({
  watchNativePushMessages: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('./retire', () => ({ retireRoomAlerts: vi.fn(), retireReadAlerts: vi.fn() }));
vi.mock('./sound', () => ({ playNotificationSound: mocks.playNotificationSound }));

import { NotificationCenter } from './notifications.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';

beforeEach(() => {
  mocks.playNotificationSound.mockClear();
  preferences.notificationSounds = true;
  preferences.backgroundNotificationSounds = true;
});

test('plays sound for noisy native notifications', () => {
  new NotificationCenter().present({
    user_id: '@me:example.org',
    room_id: '!room:example.org',
    event_id: '$event',
    room_name: 'Alice',
    room_avatar_url: null,
    is_direct: true,
    encrypted: false,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar_url: null,
    body: 'hello',
    mention: false,
    noisy: true,
  });

  expect(mocks.playNotificationSound).toHaveBeenCalledOnce();
});
