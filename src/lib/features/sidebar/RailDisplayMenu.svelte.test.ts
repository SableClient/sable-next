// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import RailDisplayMenu from './RailDisplayMenu.svelte';

const initial = preferences.showUnreadCounts;

afterEach(() => {
  setPreference('showUnreadCounts', initial);
});

test('display options are independent checkbox toggles', async () => {
  const user = userEvent.setup();
  render(RailDisplayMenu, { props: { open: true, anchor: null, foldersOpen: false } });

  const toggles = await screen.findAllByRole('menuitemcheckbox');
  expect(toggles).toHaveLength(5);
  expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();

  const unread = screen.getByRole('menuitemcheckbox', { name: 'Show counts on quiet rooms' });
  expect(unread).toHaveAttribute('aria-checked', String(initial));
  await user.click(unread);

  expect(preferences.showUnreadCounts).toBe(!initial);
  expect(unread).toHaveAttribute('aria-checked', String(!initial));
});
