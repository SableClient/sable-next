// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', async () => {
  const { page: shared } = await import('#lib/test-support/app-state.js');
  class Page {
    url = $state.raw(new URL('http://localhost/to/%40alice%3Aexample.org?action=chat'));
    state = shared.state;
  }
  return { page: new Page() };
});
vi.mock('#lib/rooms/room-list.svelte.js', async (original) => ({
  ...(await original<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    rooms: [],
    settled: true,
    start: () => new Promise<void>((resolve) => setTimeout(resolve)),
  }),
}));

import { page } from '$app/state';
import { core } from '#lib/core/__mocks__/context.js';
import { i18n } from '#lib/i18n.js';
import Page from './+page.svelte';

test('a cancelled chat prompt stays closed when its history entry pops', async () => {
  core.userProfile.mockResolvedValue({ display_name: 'Alice', avatar_url: null });
  render(Page);
  await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
  await vi.waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  Object.assign(page, { url: new URL(page.url.href) });

  await screen.findByRole('heading', { name: 'Alice' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole('dialog')).toBeNull();
});
