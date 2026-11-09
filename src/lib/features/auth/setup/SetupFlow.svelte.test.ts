// @vitest-environment happy-dom

import { render, screen, waitFor, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { goto } from '$app/navigation';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import SetupFlow from './SetupFlow.svelte';

const logout = vi.fn(() => {
  Object.assign(core, { session: null, accounts: [] });
  return Promise.resolve();
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(core, {
    session: {
      account_id: 'wrong',
      user_id: '@wrong:example.org',
      device_id: 'DEVICE',
      homeserver: 'https://example.org',
      needs_reauth: false,
    },
    accounts: [],
    status: 'ready',
    encryption: null,
    logout,
    rpc: {
      encryption: { signOutSafety: () => Promise.reject(new Error('offline')) },
      account: { getProfile: () => new Promise(() => {}) },
    },
  });
});

test('an account signed into by mistake can log out before finishing setup', async () => {
  const user = userEvent.setup();
  render(SetupFlow);

  await user.click(screen.getByRole('button', { name: 'settings.logout' }));
  const warning = await screen.findByRole('dialog', { name: 'settings.logoutWarning.title' });
  await user.click(within(warning).getByRole('button', { name: 'settings.logoutWarning.confirm' }));

  await waitFor(() => {
    expect(logout).toHaveBeenCalledOnce();
    expect(goto).toHaveBeenCalledWith('/login');
  });
});
