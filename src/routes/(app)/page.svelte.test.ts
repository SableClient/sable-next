// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
const navigating = vi.hoisted(() => ({ to: null as unknown }));
vi.mock('$app/state', () => ({ navigating }));
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
import Page from './+page.svelte';

afterEach(() => {
  setPreference('showHome', false);
  navigating.to = null;
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

test('leaves a navigation already in flight alone', async () => {
  navigating.to = { url: new URL('http://localhost/direct/!room') };
  render(Page);
  await tick();

  expect(goto).not.toHaveBeenCalled();
});
