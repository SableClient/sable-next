// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import SetupActions from './SetupActions.svelte';

test('skip and log out share one row', async () => {
  const user = userEvent.setup();
  const skip = vi.fn();
  const onLogout = vi.fn();
  render(SetupActions, { skip: { onclick: skip }, onLogout });

  await user.click(screen.getByRole('button', { name: 'auth.skipForNow' }));
  await user.click(screen.getByRole('button', { name: 'settings.logout' }));

  expect(skip).toHaveBeenCalledOnce();
  expect(onLogout).toHaveBeenCalledOnce();
});

test('a step with nothing to skip only offers log out', () => {
  render(SetupActions, { skip: null, onLogout: vi.fn() });

  expect(screen.queryByRole('button', { name: 'auth.skipForNow' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'settings.logout' })).toBeInTheDocument();
});

test('a busy step holds its skip', () => {
  render(SetupActions, { skip: { onclick: vi.fn(), disabled: true }, onLogout: vi.fn() });

  expect(screen.getByRole('button', { name: 'auth.skipForNow' })).toBeDisabled();
});

test('a failed log out says so', () => {
  render(SetupActions, { skip: null, onLogout: vi.fn(), logoutFailed: true });

  expect(screen.getByRole('alert')).toHaveTextContent('setup.logoutFailed');
});
