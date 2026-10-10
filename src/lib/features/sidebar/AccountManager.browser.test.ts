import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { ProfileView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { core } from '#lib/core/__mocks__/context.js';
import { goto } from '#lib/test-support/app-navigation.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import AccountManager from './AccountManager.svelte';

afterEach(async () => {
  setPreference('presence', 'online');
  setPreference('presenceStatusMessage', '');
  setPreference('sendPresence', true);
  await page.viewport(414, 800);
});

function profileWith(patch: Partial<ProfileView>): ProfileView {
  return {
    user_id: '@alice:example.test',
    display_name: 'Alice',
    avatar_url: null,
    bio: null,
    hero_color: null,
    hero_brightness: null,
    banner_url: null,
    status: null,
    pronouns: [],
    timezone: null,
    name_color_light: null,
    name_color_dark: null,
    animal: null,
    extra: [],
    supporter_awards: null,
    legacy_fields: [],
    ...patch,
  };
}

async function mount(initial: ProfileView, options: { saveFails?: () => boolean } = {}) {
  const setProfileField = vi.fn((_field: string, _value: unknown) =>
    options.saveFails?.() ? Promise.reject(new Error('save failed')) : Promise.resolve()
  );
  Object.assign(core, {
    session: { user_id: '@alice:example.test', account_id: 'a1', homeserver: 'example.test' },
    accounts: [
      {
        account_id: 'a1',
        user_id: '@alice:example.test',
        device_id: 'D1',
        homeserver: 'https://example.test',
        needs_reauth: false,
      },
      {
        account_id: 'second-account',
        user_id: '@second:example.test',
        device_id: 'D2',
        homeserver: 'https://example.test',
        needs_reauth: false,
      },
    ],
    userProfile: vi.fn((userId: string) =>
      Promise.resolve(
        userId === '@second:example.test'
          ? profileWith({ user_id: userId, display_name: 'Second' })
          : initial
      )
    ),
    setProfileField,
    switchAccount: vi.fn().mockResolvedValue(undefined),
    removeAccount: vi.fn().mockResolvedValue(undefined),
    cachedUserProfile: vi.fn(() => null),
  });
  core.commands = core;
  const screen = await render(AccountManager);
  const bubble = () => {
    const node = document.querySelector<HTMLElement>('.status-bubble');
    if (!node) throw new Error('the status bubble is not rendered');
    return node;
  };
  return { screen, bubble, setProfileField };
}

for (const [name, width, height] of [
  ['desktop', 1280, 800],
  ['mobile', 412, 915],
] as const) {
  test(`${name}: presence and status stay unchanged until Save`, async () => {
    await page.viewport(width, height);
    setPreference('presence', 'online');
    const { screen, bubble } = await mount(
      profileWith({ status: { text: 'Working on Sable', emoji: null } })
    );
    await expect.poll(() => bubble().textContent).toContain('Working on Sable');
    await userEvent.click(bubble());
    const dialog = screen.getByRole('dialog');
    const editor = dialog.getByRole('textbox', { name: 'Status message' });
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await expect.element(save).toBeDisabled();

    await userEvent.click(dialog.getByRole('radio', { name: 'Offline', exact: true }));
    await expect.element(save).toBeEnabled();
    await userEvent.fill(editor.element(), 'Taking a break');
    expect(bubble().textContent).toContain('Online');
    expect(bubble().textContent).toContain('Working on Sable');
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel', exact: true }).first());
    await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0);
    expect(bubble().textContent).toContain('Online');
    expect(bubble().textContent).toContain('Working on Sable');

    await userEvent.click(bubble());
    await expect
      .element(dialog.getByRole('radio', { name: 'Online', exact: true }))
      .toHaveAttribute('data-selected', 'true');
    await expect.element(editor).toHaveValue('Working on Sable');
    await userEvent.click(dialog.getByRole('radio', { name: 'Away', exact: true }));
    await userEvent.click(save);
    await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0);
    expect(bubble().textContent).toContain('Away');
    expect(bubble().textContent).toContain('Working on Sable');

    await userEvent.click(bubble());
    await userEvent.click(dialog.getByRole('radio', { name: 'Offline', exact: true }));
    await userEvent.fill(editor.element(), 'Taking a break');
    await userEvent.click(save);
    await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0);
    expect(bubble().textContent).toContain('Offline');
    expect(bubble().textContent).toContain('Taking a break');
  });

  test(`${name}: a failed status save keeps presence unchanged and preserves the draft`, async () => {
    await page.viewport(width, height);
    setPreference('presence', 'online');
    let failing = true;
    const { screen, bubble } = await mount(
      profileWith({ status: { text: 'Working on Sable', emoji: null } }),
      { saveFails: () => failing }
    );
    await expect.poll(() => bubble().textContent).toContain('Working on Sable');
    await userEvent.click(bubble());
    const dialog = screen.getByRole('dialog');
    const editor = dialog.getByRole('textbox', { name: 'Status message' });
    await userEvent.click(dialog.getByRole('radio', { name: 'Offline', exact: true }));
    await userEvent.fill(editor.element(), 'Taking a break');
    await userEvent.click(dialog.getByRole('button', { name: 'Save', exact: true }));

    await expect
      .poll(() => dialog.getByRole('alert').element().textContent)
      .toContain('Could not save your profile changes.');
    await expect.element(editor).toHaveValue('Taking a break');
    expect(bubble().textContent).toContain('Online');
    expect(bubble().textContent).toContain('Working on Sable');

    failing = false;
    await userEvent.click(dialog.getByRole('button', { name: 'Save', exact: true }));
    await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0);
    expect(bubble().textContent).toContain('Offline');
    expect(bubble().textContent).toContain('Taking a break');
  });
}

for (const sendPresence of [false, true]) {
  test(`the account page shows the saved profile status with presence sharing ${String(sendPresence)}`, async () => {
    await page.viewport(1280, 800);
    setPreference('sendPresence', sendPresence);
    const { screen, bubble, setProfileField } = await mount(
      profileWith({
        status: { text: 'Working on Sable', emoji: '🚀' },
        legacy_fields: ['chat.commet.profile_status'],
      })
    );
    const status = () =>
      sendPresence
        ? bubble()
        : screen.getByRole('region', { name: 'Status', exact: true }).element();
    await expect.poll(() => status().textContent).toContain('Working on Sable');
    expect(status().textContent).toContain('🚀');
    expect(document.querySelector('.profile-card')?.textContent).not.toContain(
      'What are you up to?'
    );
    if (!sendPresence) return;

    expect(document.querySelectorAll('.profile-card-status')).toHaveLength(0);
    await userEvent.click(bubble());
    await expect.element(screen.getByRole('radio', { name: 'Online', exact: true })).toHaveFocus();
    const editor = screen.getByRole('textbox', { name: 'Status message' });
    await expect.element(editor).toHaveValue('Working on Sable');
    await userEvent.fill(editor.element(), 'Taking a break');
    await userEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0);
    expect(status().textContent).toContain('Taking a break');
    expect(status().textContent).toContain('🚀');
    expect(setProfileField).toHaveBeenCalledWith('m.status', {
      text: 'Taking a break',
      emoji: '🚀',
    });
    expect(setProfileField).toHaveBeenCalledWith('chat.commet.profile_status', null);

    await userEvent.click(status());
    await expect.element(screen.getByRole('radio', { name: 'Online', exact: true })).toHaveFocus();
    await expect.element(editor).toHaveValue('Taking a break');
    await userEvent.fill(editor.element(), '');
    await expect.element(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await expect.poll(() => status().textContent).toContain('What are you up to?');
    expect(setProfileField).toHaveBeenCalledWith('m.status', null);
  });
}

test('mobile: the account page omits the profile biography', async () => {
  await page.viewport(412, 915);
  const { screen } = await mount(profileWith({ bio: '<p>My profile biography.</p>' }));

  await expect
    .element(screen.getByRole('button', { name: 'Edit profile', exact: true }))
    .toBeVisible();
  expect(screen.getByRole('heading', { name: 'Biography' }).elements()).toHaveLength(0);
  expect(screen.getByText('My profile biography.', { exact: true }).elements()).toHaveLength(0);
});

test('mobile: tapping an account identity switches to that account', async () => {
  await page.viewport(412, 915);
  const { screen } = await mount(profileWith({}));
  await expect.element(screen.getByRole('button', { pressed: true })).toBeDisabled();

  await userEvent.click(screen.getByText('Second', { exact: true }));

  await expect.poll(() => core.switchAccount).toHaveBeenCalledWith('second-account');
  await expect.poll(() => goto.mock.calls.length).toBeGreaterThan(0);
});

test('mobile: account options do not select the account', async () => {
  await page.viewport(412, 915);
  const { screen } = await mount(profileWith({}));
  await userEvent.click(
    screen.getByRole('button', { name: 'More options: @second:example.test', exact: true })
  );
  await expect.element(screen.getByRole('menuitem', { name: 'Remove account' })).toBeVisible();
  expect(core.switchAccount).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }));
  const confirmation = screen.getByRole('dialog', { name: 'Remove this account?' });
  await expect.element(confirmation.getByText('Second', { exact: true })).toBeVisible();
  await expect
    .element(confirmation.getByText('@second:example.test', { exact: true }))
    .toBeVisible();
  await userEvent.click(confirmation.getByRole('button', { name: 'Cancel', exact: true }));
  await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0);
});

test('mobile: switching shows progress and a failed switch can be retried', async () => {
  await page.viewport(412, 915);
  const { screen } = await mount(profileWith({}));
  let failing = true;
  const switchAccount = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        setTimeout(
          () => {
            if (failing) reject(new Error('no'));
            else resolve();
          },
          failing ? 300 : 0
        );
      })
  );
  Object.assign(core, { switchAccount });
  const account = screen.getByRole('button', {
    name: 'Switch account: Second, @second:example.test',
    exact: true,
  });
  await expect.element(account).toBeVisible();

  await userEvent.click(account);
  await expect.element(account).toHaveAttribute('aria-busy', 'true');
  await expect.element(account.getByText('Switching…', { exact: true })).toBeVisible();
  await expect.element(account).toBeDisabled();
  await expect

    .poll(() => document.querySelector('.account-list [role="alert"]')?.textContent.trim())
    .toBe('Could not switch accounts. Try again.');
  await expect.element(account).toBeEnabled();
  await expect.element(account).toHaveAttribute('aria-busy', 'false');
  await expect
    .element(screen.getByRole('button', { pressed: true }))
    .toHaveAccessibleName('Active account: Alice, @alice:example.test');

  failing = false;
  await userEvent.click(account);
  await expect.poll(() => switchAccount.mock.calls.length).toBe(2);
  await expect.poll(() => goto.mock.calls.length).toBeGreaterThan(0);
});
