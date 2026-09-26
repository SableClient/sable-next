// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/rooms' }, params: {}, state: history.state },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));

import ActionMenuHarness from './ActionMenuHarness.test.svelte';

afterEach(() => {
  history.state.overlay = undefined;
  vi.unstubAllGlobals();
});

function narrowViewport(): void {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

test('a wide viewport opens the anchored menu, and Escape gives the page back', async () => {
  const user = userEvent.setup();
  render(ActionMenuHarness, { onPick: vi.fn() });

  await user.click(screen.getByRole('button', { name: 'Room options' }));

  expect(await screen.findByRole('menu', { name: 'Room options' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  await user.keyboard('{Escape}');

  await vi.waitFor(() => {
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).toBe('');
  });
});

test('a narrow viewport closes its sheet and then runs the menu action', async () => {
  narrowViewport();
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(ActionMenuHarness, { onPick });

  await user.click(screen.getByRole('button', { name: 'Room options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Mark as read' }));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(onPick).toHaveBeenCalledOnce();
  });
});

test('a narrow viewport opens a bottom sheet, and a submenu pushes a second one', async () => {
  narrowViewport();
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(ActionMenuHarness, { onPick });

  await user.click(screen.getByRole('button', { name: 'Room options' }));

  expect(await screen.findAllByRole('dialog')).toHaveLength(1);
  expect(screen.getAllByRole('menuitem').map((row) => row.textContent.trim())).toEqual([
    'Mark as read',
    'Notifications',
  ]);

  await user.click(screen.getByRole('menuitem', { name: 'Notifications' }));

  expect(await screen.findAllByRole('dialog')).toHaveLength(2);
  const checked = screen.getByRole('menuitemradio', { name: 'All messages' });
  expect(checked).toBeChecked();

  await user.click(checked);

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(onPick).toHaveBeenCalledOnce();
  });
});
