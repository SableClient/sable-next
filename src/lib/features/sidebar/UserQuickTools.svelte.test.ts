// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { visit } from '#lib/test-support/app-state.js';
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [], notificationMode: () => 'all_messages' }),
}));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/presence.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePresenceStore: () => ({ get: () => null, peek: () => null }),
}));

import { paletteState } from '#lib/ui/shortcuts/palette-state.svelte.js';
import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
import UserQuickTools from './UserQuickTools.svelte';

beforeEach(() => {
  visit('/rooms');
});

afterEach(() => {
  paletteState.open = false;
});

function setup(props: { mobile?: boolean; compact?: boolean } = { mobile: true }): void {
  render(UserQuickTools, props, { wrapper: TooltipProvider });
}

test('the mobile bar links navigation and inbox as pages, not overlays', async () => {
  setup();

  const navigate = screen.getByRole('link', { name: 'shortcuts.openRoomSearch' });
  expect(navigate).toHaveAttribute('href', '/navigate');
  await fireEvent.click(navigate);
  expect(paletteState.open).toBe(false);

  const inbox = screen.getByRole('link', { name: 'nav.inbox' });
  expect(inbox).toHaveAttribute('href', '/inbox');
  expect(await fireEvent.click(inbox)).toBe(true);
});

test('the mobile bar keeps a slot per tool', () => {
  setup();

  const bar = screen.getByRole('navigation', { name: 'nav.quickTools' });
  expect(bar.style.getPropertyValue('--mobile-slot-count')).toBe('4');
  expect(bar.querySelectorAll('.mobile-tool-slot')).toHaveLength(4);
});

test.each([{ compact: false }, { compact: true }])(
  'the desktop inbox navigates to the full page with compact=$compact',
  async (props) => {
    setup(props);
    const inbox = screen.getByRole('link', { name: 'nav.inbox' });
    expect(inbox).toHaveAttribute('href', '/inbox');
    expect(await fireEvent.click(inbox)).toBe(true);
  }
);

test('the desktop inbox stays a page link when already selected', async () => {
  visit('/inbox');
  setup({ mobile: false });
  const inbox = screen.getByRole('link', { name: 'nav.inbox' });
  expect(inbox).toHaveAttribute('aria-current', 'page');
  expect(await fireEvent.click(inbox)).toBe(true);
});

test('the mobile bar marks the profile tab as selected on the profile page', () => {
  visit('/profile');
  setup();

  const bar = screen.getByRole('navigation');
  expect(bar).toHaveClass('selection-active');
  expect(bar.style.getPropertyValue('--mobile-selected-index')).toBe('3');
});

test('the collapsed sidebar leaves message search to the rail', () => {
  setup({ compact: true });

  expect(screen.getByRole('navigation', { name: 'nav.quickTools' })).toHaveClass('compact-tools');
  expect(screen.queryByRole('link', { name: 'nav.search' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href="/search"]')).not.toBeInTheDocument();
});
