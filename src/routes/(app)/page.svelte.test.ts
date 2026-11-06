// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => ({
    status: 'ready',
    session: { user_id: '@me:example.org', device_id: 'DEVICE', account_id: 'me' },
  }),
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [], settled: true, byId: () => undefined }),
}));

import { goto, resetNavigation } from '#lib/test-support/app-navigation.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { trackNotificationOpening } from '#lib/features/notifications/notification-opening.svelte.js';
import Page from './+page.svelte';

afterEach(() => {
  setPreference('showHome', false);
  resetNavigation();
});

test('starts on rooms by default', async () => {
  render(Page);
  await tick();

  expect(goto).toHaveBeenCalledWith('/rooms', { replace: true });
});

test('starts on Home when it is enabled', async () => {
  setPreference('showHome', true);
  render(Page);
  await tick();

  expect(goto).toHaveBeenCalledWith('/home', { replace: true });
});

test('waits for a notification being opened before restoring a room', async () => {
  const opened = Promise.withResolvers<undefined>();
  const opening = trackNotificationOpening(opened.promise);
  render(Page);
  await tick();

  expect(goto).not.toHaveBeenCalled();

  opened.resolve(undefined);
  await opening;
  await tick();

  expect(goto).toHaveBeenCalledWith('/rooms', { replace: true });
});
