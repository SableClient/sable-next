// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/settings/preferences.svelte.js', () => ({
  preferences: { sendPresence: false, presence: 'online' },
  setPreference: vi.fn(),
}));

import AccountMenuItemsHarness from './AccountMenuItemsHarness.test.svelte';
import { AccountDirectory } from './account-directory.svelte.js';

import type { CoreClient } from '#lib/core/client.svelte.js';

const accounts = [
  {
    account_id: 'current',
    user_id: '@current:example.org',
    device_id: 'DESKTOP',
    homeserver: 'https://example.org',
    needs_reauth: false,
  },
  {
    account_id: 'other',
    user_id: '@other:example.net',
    device_id: 'PHONE',
    homeserver: 'https://example.net',
    needs_reauth: false,
  },
];

const user = userEvent.setup();

async function openMenu(): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(document.body.style.pointerEvents).toBe('');
  });
  await user.click(screen.getByRole('button', { name: 'Account options' }));
  return screen.findByRole('menu');
}

async function openSwitcher(): Promise<void> {
  const menu = await openMenu();
  await user.click(within(menu).getByRole('menuitem', { name: 'nav.switchAccount' }));
}

const account = (userId: string) =>
  screen.getByRole('menuitemradio', { name: new RegExp(userId.replace(/\./g, '\\.')) });

function accountRow(userId: string) {
  const row = account(userId).closest<HTMLElement>('.account-row');
  if (!row) throw new Error(`no row for ${userId}`);
  return within(row);
}

function directoryWith(userProfile: (userId: string) => Promise<unknown>): AccountDirectory {
  const core = {
    session: { account_id: 'current' },
    userProfile: vi.fn(userProfile),
  } as unknown as CoreClient;
  return new AccountDirectory(core);
}

test('opens account choices in the switch-account submenu', async () => {
  const onSwitch = vi.fn();
  const onLogoutAccount = vi.fn();
  render(AccountMenuItemsHarness, {
    accounts,
    profiles: directoryWith(() => Promise.reject(new Error('profile unavailable'))),
    onSwitch,
    onLogoutAccount,
  });

  await openSwitcher();

  expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
  expect(account('@current:example.org')).toBeDisabled();
  expect(account('@current:example.org')).toBeChecked();
  await user.click(
    accountRow('@other:example.net').getByRole('button', { name: 'settings.logout' })
  );
  expect(onLogoutAccount).toHaveBeenCalledWith('other');

  await openSwitcher();
  await user.click(account('@other:example.net'));
  expect(onSwitch).toHaveBeenCalledWith('other');
});

test('loads the profile avatar of every account', async () => {
  const userProfile = vi.fn((userId: string) => {
    if (userId === '@other:example.net') {
      return Promise.resolve({ display_name: 'Zed', avatar_url: 'https://example.net/pic.png' });
    }
    return Promise.resolve({ display_name: null, avatar_url: null });
  });
  const profiles = directoryWith(userProfile);
  render(AccountMenuItemsHarness, {
    accounts,
    profiles,
    onSwitch: vi.fn(),
    onLogoutAccount: vi.fn(),
  });

  await openSwitcher();

  await vi.waitFor(() => {
    expect(userProfile.mock.calls.map(([userId]) => userId)).toEqual(
      expect.arrayContaining(['@current:example.org', '@other:example.net'])
    );
  });
  await vi.waitFor(() => {
    expect(account('@other:example.net').querySelector('.avatar-fallback')).toHaveTextContent('Z');
  });
});

test('a deployment without account switching offers neither switching nor adding', async () => {
  render(AccountMenuItemsHarness, {
    accounts,
    profiles: directoryWith(() => Promise.reject(new Error('profile unavailable'))),
    onSwitch: vi.fn(),
    onLogoutAccount: vi.fn(),
    accountSwitching: false,
  });

  const menu = within(await openMenu());

  expect(menu.getByRole('menuitem', { name: 'nav.editProfile' })).toBeInTheDocument();
  expect(menu.queryByRole('menuitem', { name: 'nav.switchAccount' })).not.toBeInTheDocument();
  expect(menu.queryByRole('menuitem', { name: 'common.addAccount' })).not.toBeInTheDocument();
});

test('a signed-out account says so and offers to sign in again', async () => {
  const onSwitch = vi.fn();
  const onReauth = vi.fn();
  const signedOut = { ...accounts[1], needs_reauth: true };
  render(AccountMenuItemsHarness, {
    accounts: [accounts[0], signedOut],
    profiles: directoryWith(() => Promise.reject(new Error('profile unavailable'))),
    onSwitch,
    onLogoutAccount: vi.fn(),
    onReauth,
  });

  await openSwitcher();

  const select = account('@other:example.net');
  expect(select).toBeEnabled();
  expect(select).toHaveTextContent('nav.accountSignedOut');
  await user.click(select);
  expect(onReauth).toHaveBeenCalledWith(signedOut);
  expect(onSwitch).not.toHaveBeenCalled();
});
