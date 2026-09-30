// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SessionInfo } from '#src/generated/protocol';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/presence.svelte.js', () => ({
  usePresenceStore: () => ({ get: () => null }),
}));
vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: () => Promise.resolve({ disableAccountSwitcher: false, push: null }),
}));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/settings/preferences.svelte.js')>()),
  preferences: { sendPresence: false, presence: 'online' },
  setPreference: vi.fn(),
}));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  afterOverlayPops: () => Promise.resolve(),
  holdOverlayBack: () => {},
}));

import { core } from '#lib/core/__mocks__/context.js';
import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
import AccountSwitcher from './AccountSwitcher.svelte';

const current = {
  account_id: 'current',
  user_id: '@current:example.org',
  device_id: 'DESKTOP',
  homeserver: 'https://example.org',
  needs_reauth: false,
};
const suspended = {
  ...current,
  account_id: 'suspended',
  user_id: '@suspended:example.org',
  needs_reauth: true,
};

const switchAccount = vi.fn<(accountId: string) => Promise<void>>(() =>
  Promise.reject(new Error('not_logged_in'))
);
const removeAccount = vi.fn((accountId: string) => {
  core.accounts = core.accounts.filter(
    (account) => (account as SessionInfo).account_id !== accountId
  );
  return Promise.resolve();
});
const logout = vi.fn(() => Promise.resolve());
const signOutSafety = vi.fn(() => Promise.reject(new Error('not_logged_in')));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(core, {
    session: current,
    accounts: [current, suspended],
    status: 'ready',
    switchAccount,
    removeAccount,
    logout,
    signOutSafety,
  });
});

async function requestLogout(userId: string) {
  const user = userEvent.setup();
  render(AccountSwitcher, { mode: 'desktop' }, { wrapper: TooltipProvider });

  await user.click(screen.getByRole('button', { name: 'nav.switchAccount' }));
  await user.click(screen.getByRole('menuitem', { name: 'nav.switchAccount' }));
  const account = screen.getByRole('menuitemradio', { name: new RegExp(userId) });
  const row = account.closest<HTMLElement>('.account-row');
  if (!row) throw new Error('Missing account row');
  await user.click(within(row).getByRole('button', { name: 'settings.logout' }));

  const dialog = await screen.findByRole('dialog', { name: 'settings.logout' });
  return { user, dialog };
}

test('logs out a suspended secondary account while keeping the current account active', async () => {
  const { user, dialog } = await requestLogout(suspended.user_id);
  await user.click(within(dialog).getByRole('button', { name: 'settings.logout' }));

  await vi.waitFor(() => {
    expect(removeAccount).toHaveBeenCalledWith(suspended.account_id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(core.accounts).toEqual([current]);
  expect(core.session).toEqual(current);
  expect(switchAccount).not.toHaveBeenCalled();
  expect(logout).not.toHaveBeenCalled();
  expect(signOutSafety).not.toHaveBeenCalled();
});

test('cancelling logout keeps the suspended account saved', async () => {
  const { user, dialog } = await requestLogout(suspended.user_id);
  await user.click(within(dialog).getByRole('button', { name: 'settings.cancel' }));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(core.accounts).toEqual([current, suspended]);
  expect(removeAccount).not.toHaveBeenCalled();
  expect(switchAccount).not.toHaveBeenCalled();
});

test('checks encryption safety before logging out a healthy secondary account', async () => {
  const healthy = { ...suspended, needs_reauth: false };
  core.accounts = [current, healthy];
  switchAccount.mockImplementationOnce(() => {
    core.session = healthy;
    return Promise.resolve();
  });
  const { user, dialog } = await requestLogout(healthy.user_id);
  await user.click(within(dialog).getByRole('button', { name: 'settings.logout' }));

  const warning = await screen.findByRole('dialog', { name: 'settings.logoutWarning.title' });
  expect(switchAccount).toHaveBeenCalledWith(healthy.account_id);
  expect(signOutSafety).toHaveBeenCalledOnce();
  expect(logout).not.toHaveBeenCalled();
  expect(removeAccount).not.toHaveBeenCalled();

  await user.click(within(warning).getByRole('button', { name: 'settings.logoutWarning.confirm' }));
  await vi.waitFor(() => {
    expect(logout).toHaveBeenCalledOnce();
  });
});

test('uses session logout for the active account even if it requires reauthentication', async () => {
  const active = { ...current, needs_reauth: true };
  core.session = active;
  core.accounts = [active, suspended];
  const { user, dialog } = await requestLogout(active.user_id);
  await user.click(within(dialog).getByRole('button', { name: 'settings.logout' }));

  const warning = await screen.findByRole('dialog', { name: 'settings.logoutWarning.title' });
  expect(signOutSafety).toHaveBeenCalledOnce();
  expect(removeAccount).not.toHaveBeenCalled();
  expect(switchAccount).not.toHaveBeenCalled();

  await user.click(within(warning).getByRole('button', { name: 'settings.logoutWarning.confirm' }));
  await vi.waitFor(() => {
    expect(logout).toHaveBeenCalledOnce();
  });
});
