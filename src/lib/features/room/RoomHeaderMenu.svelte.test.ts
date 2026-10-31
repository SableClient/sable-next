// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import RoomHeaderMenu from './RoomHeaderMenu.svelte';

function renderMenu(onClose?: () => void) {
  render(RoomHeaderMenu, {
    room: null,
    canInvite: false,
    compact: false,
    onMarkRead: vi.fn(),
    onMarkUnread: vi.fn(),
    onInvite: vi.fn(),
    onMembers: vi.fn(),
    onSettings: vi.fn(),
    onReport: vi.fn(),
    onLeave: vi.fn(),
    onClose,
  });
}

test('the room menu closes the open chat', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  renderMenu(onClose);

  await user.click(screen.getByRole('button', { name: 'More options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Close chat' }));

  expect(onClose).toHaveBeenCalledOnce();
});

test('the room menu offers no close item where the header has a back button', async () => {
  const user = userEvent.setup();
  renderMenu();

  await user.click(screen.getByRole('button', { name: 'More options' }));
  await screen.findByRole('menu');

  expect(screen.queryByRole('menuitem', { name: 'Close chat' })).toBeNull();
});
