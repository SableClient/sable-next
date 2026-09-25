// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));
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

afterEach(() => {
  document.body.replaceChildren();
});

async function press(element: Element): Promise<void> {
  element.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
    })
  );
  element.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse' })
  );
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
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
  const instance = mount(AccountMenuItemsHarness, {
    target: document.body,
    props: {
      accounts,
      profiles: directoryWith(() => Promise.reject(new Error('profile unavailable'))),
      onSwitch,
      onLogoutAccount,
    },
  });
  await tick();

  async function openSwitcher(): Promise<void> {
    const outerMenu = document.querySelector('.account-menu-trigger');
    expect(outerMenu).not.toBeNull();
    if (outerMenu) await press(outerMenu);
    const switcher = [...document.querySelectorAll('.menu-item')].find((item) =>
      item.textContent.includes('nav.switchAccount')
    );
    expect(switcher).not.toBeUndefined();
    if (switcher) await press(switcher);
  }

  await openSwitcher();

  const rows = document.querySelectorAll('.account-row');
  expect(rows).toHaveLength(2);
  const activeRow = rows.item(0);
  const otherRow = rows.item(1);
  expect((activeRow.querySelector('.account-select') as HTMLButtonElement).disabled).toBe(true);
  await press(otherRow.querySelector('.btn-danger') as HTMLButtonElement);
  expect(onLogoutAccount).toHaveBeenCalledWith('other');

  await openSwitcher();
  const otherAccount = document.querySelectorAll('.account-row').item(1);
  await press(otherAccount.querySelector('.account-select') as HTMLButtonElement);
  expect(onSwitch).toHaveBeenCalledWith('other');
  await unmount(instance);
});

test('loads the profile avatar of every account', async () => {
  const userProfile = vi.fn((userId: string) => {
    if (userId === '@other:example.net') {
      return Promise.resolve({ display_name: 'Zed', avatar_url: 'https://example.net/pic.png' });
    }
    return Promise.resolve({ display_name: null, avatar_url: null });
  });
  const profiles = directoryWith(userProfile);
  const instance = mount(AccountMenuItemsHarness, {
    target: document.body,
    props: { accounts, profiles, onSwitch: vi.fn(), onLogoutAccount: vi.fn() },
  });
  await tick();

  const outerMenu = document.querySelector('.account-menu-trigger');
  expect(outerMenu).not.toBeNull();
  if (outerMenu) await press(outerMenu);
  const switcher = [...document.querySelectorAll('.menu-item')].find((item) =>
    item.textContent.includes('nav.switchAccount')
  );
  expect(switcher).not.toBeUndefined();
  if (switcher) await press(switcher);

  await vi.waitFor(() => {
    expect(userProfile.mock.calls.map(([userId]) => userId)).toEqual(
      expect.arrayContaining(['@current:example.org', '@other:example.net'])
    );
  });

  const otherRow = document.querySelectorAll('.account-row').item(1);
  const avatar = otherRow.querySelector('.avatar-fallback');
  expect(avatar?.textContent).toBe('Z');
  await unmount(instance);
});

test('a deployment without account switching offers neither switching nor adding', async () => {
  const instance = mount(AccountMenuItemsHarness, {
    target: document.body,
    props: {
      accounts,
      profiles: directoryWith(() => Promise.reject(new Error('profile unavailable'))),
      onSwitch: vi.fn(),
      onLogoutAccount: vi.fn(),
      accountSwitching: false,
    },
  });
  await tick();

  const outerMenu = document.querySelector('.account-menu-trigger');
  expect(outerMenu).not.toBeNull();
  if (outerMenu) await press(outerMenu);

  const labels = [...document.querySelectorAll('.menu-item')].map((item) => item.textContent);
  expect(labels.some((label) => label.includes('nav.editProfile'))).toBe(true);
  expect(labels.some((label) => label.includes('nav.switchAccount'))).toBe(false);
  expect(labels.some((label) => label.includes('nav.addAccount'))).toBe(false);
  await unmount(instance);
});

test('a signed-out account says so and offers to sign in again', async () => {
  const onSwitch = vi.fn();
  const onReauth = vi.fn();
  const signedOut = { ...accounts[1], needs_reauth: true };
  const instance = mount(AccountMenuItemsHarness, {
    target: document.body,
    props: {
      accounts: [accounts[0], signedOut],
      profiles: directoryWith(() => Promise.reject(new Error('profile unavailable'))),
      onSwitch,
      onLogoutAccount: vi.fn(),
      onReauth,
    },
  });
  await tick();

  const outerMenu = document.querySelector('.account-menu-trigger');
  expect(outerMenu).not.toBeNull();
  if (outerMenu) await press(outerMenu);
  const switcher = [...document.querySelectorAll('.menu-item')].find((item) =>
    item.textContent.includes('nav.switchAccount')
  );
  expect(switcher).not.toBeUndefined();
  if (switcher) await press(switcher);

  const row = document.querySelectorAll('.account-row').item(1);
  const select = row.querySelector('.account-select') as HTMLButtonElement;
  expect(select.disabled).toBe(false);
  expect(select.textContent).toContain('nav.accountSignedOut');
  await press(select);
  expect(onReauth).toHaveBeenCalledWith(signedOut);
  expect(onSwitch).not.toHaveBeenCalled();
  await unmount(instance);
});
