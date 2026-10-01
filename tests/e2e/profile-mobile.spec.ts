import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { Page } from '@playwright/test';

async function expectCompactIdentity(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const spacing = await page.locator('.profile-card').evaluate((card) => {
    const avatarElement = card.querySelector('.profile-card-avatar');
    const status = card
      .querySelector('.status-bubble, .profile-card-status')
      ?.getBoundingClientRect();
    const name = card.querySelector('.profile-card-name');
    const id = card.querySelector('.profile-card-user-id');
    if (!avatarElement || !name || !id) throw new Error('The profile identity is not laid out.');
    const avatar = avatarElement.getBoundingClientRect();
    const nameRange = document.createRange();
    nameRange.selectNodeContents(name);
    const idRange = document.createRange();
    idRange.selectNodeContents(id);
    return {
      avatarGap: name.getBoundingClientRect().top - Math.max(avatar.bottom, status?.bottom ?? 0),
      textGap: idRange.getBoundingClientRect().top - nameRange.getBoundingClientRect().bottom,
      idHeight: id.getBoundingClientRect().height,
    };
  });
  expect(spacing.avatarGap).toBeGreaterThanOrEqual(8);
  expect(spacing.avatarGap).toBeLessThanOrEqual(12);
  expect(spacing.textGap).toBeGreaterThanOrEqual(0);
  expect(spacing.textGap).toBeLessThanOrEqual(8);
  expect(spacing.idHeight).toBeGreaterThanOrEqual(48);
}

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__e2eAccounts = [
      {
        account_id: 'e2e-account',
        user_id: '@e2e:example.test',
        device_id: 'E2EDEVICE',
        homeserver: 'https://example.test',
        needs_reauth: false,
      },
      {
        account_id: 'second-account',
        user_id: '@second:example.test',
        device_id: 'SECONDDEVICE',
        homeserver: 'https://example.test',
        needs_reauth: false,
      },
    ];
  });
});

test('mobile: settings are below the profile card and editing stays inside it', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expectCompactIdentity(page);

  const cardBox = await page.locator('.profile-card').boundingBox();
  const coverBox = await page.locator('.profile-card-cover').boundingBox();
  const statusBox = await page.locator('.status-bubble').boundingBox();
  const nameBox = await page.locator('.profile-card-name').boundingBox();
  if (!cardBox || !coverBox || !statusBox || !nameBox) {
    throw new Error('The profile card is not laid out.');
  }
  expect(statusBox.y).toBeLessThan(coverBox.y + coverBox.height);
  expect(statusBox.y + statusBox.height).toBeGreaterThan(coverBox.y + coverBox.height);
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(nameBox.y);

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const editProfile = page.getByRole('button', { name: 'Edit profile', exact: true });
  await expect(settings.locator('svg')).toHaveCount(1);
  await expect(editProfile).toBeVisible();
  const settingsBox = await settings.boundingBox();
  const editProfileBox = await editProfile.boundingBox();
  const accountsBox = await page.getByRole('heading', { name: 'Accounts' }).boundingBox();
  if (!settingsBox || !editProfileBox || !accountsBox)
    throw new Error('Profile actions and accounts are not laid out.');
  expect(settingsBox.height).toBeGreaterThanOrEqual(48);
  expect(editProfileBox.height).toBeGreaterThanOrEqual(48);
  expect(settingsBox.y).toBeGreaterThanOrEqual(cardBox.y + cardBox.height);
  expect(settingsBox.x).toBe(cardBox.x);
  expect(settingsBox.x + settingsBox.width).toBe(cardBox.x + cardBox.width);
  expect(editProfileBox.x).toBeGreaterThan(cardBox.x);
  expect(editProfileBox.x + editProfileBox.width).toBeLessThan(cardBox.x + cardBox.width);
  expect(editProfileBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
  expect(editProfileBox.y + editProfileBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
  expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(accountsBox.y);
  const addAccount = page.getByRole('button', { name: 'Add account' });
  const logout = page.getByRole('button', { name: 'Log out' });
  expect((await addAccount.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  expect((await logout.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  expect((await logout.boundingBox())?.width).toBeLessThan(cardBox.width);
  const switchAccount = page.getByRole('button', {
    name: 'Switch account: Second, @second:example.test',
    exact: true,
  });
  await expect(switchAccount).toBeVisible();
  await expect(switchAccount.getByText('Switch', { exact: true })).toBeVisible();
  for (const button of [addAccount, logout]) {
    expect(
      await button.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.borderColor, style.borderRadius];
      })
    ).toEqual(
      await editProfile.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.borderColor, style.borderRadius];
      })
    );
  }
  await settings.click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await page.goto('/profile');
  await editProfile.click();
  await expect(page).toHaveURL(/\/settings\/account$/);
});

test('mobile: the account page omits the profile biography', async ({ page, installRoomCore }) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      bio: '<p>My profile biography.</p>',
    };
  });
  await installRoomCore('ready');
  await page.goto('/profile');
  await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Biography' })).toHaveCount(0);
  await expect(page.getByText('My profile biography.', { exact: true })).toHaveCount(0);
});

test('mobile: account controls fit a narrow screen with larger text', async ({
  page,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ textScale: 1.5 }));
    if (window.__e2eAccounts) {
      window.__e2eAccounts[1].needs_reauth = true;
      window.__e2eAccounts[1].user_id = '@same-display-name-but-work-account:work.example.test';
    }
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      display_name: 'Taylor',
    };
  });
  await installRoomCore('ready');
  await page.goto('/profile');
  const reauthenticate = page.getByRole('button', {
    name: 'Sign in again: Taylor, @same-display-name-but-work-account:work.example.test',
    exact: true,
  });
  await expect(reauthenticate).toBeVisible();
  await expectCompactIdentity(page);
  await expect(reauthenticate.getByText('Signed out', { exact: true })).toBeVisible();
  await expect(
    reauthenticate.getByText('@same-display-name-but-work-account:work.example.test', {
      exact: true,
    })
  ).toBeVisible();
  expect(
    await page
      .locator('.account-manager')
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  const idBox = await reauthenticate.locator('.account-id').boundingBox();
  const avatarBox = await reauthenticate.locator('.avatar-root').boundingBox();
  const nameBox = await reauthenticate.locator('.account-name').boundingBox();
  if (!idBox || !avatarBox || !nameBox) throw new Error('The account identity is not laid out.');
  expect(idBox.x).toBeLessThanOrEqual(avatarBox.x + 1);
  expect(idBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
  const optionsBox = await page
    .getByRole('button', {
      name: 'More options: @same-display-name-but-work-account:work.example.test',
      exact: true,
    })
    .boundingBox();
  if (!optionsBox) throw new Error('The account options are not laid out.');
  expect(optionsBox.y).toBeLessThan(idBox.y);
  const active = page.getByRole('button', { pressed: true });
  const activeIdBox = await active.locator('.account-id').boundingBox();
  const activeBadgeBox = await active.locator('.status-badge').boundingBox();
  if (!activeIdBox || !activeBadgeBox) throw new Error('The active account is not laid out.');
  expect(Math.abs(activeBadgeBox.x - activeIdBox.x)).toBeLessThanOrEqual(1);
  await reauthenticate.click();
  await expect(page).toHaveURL(/\/login\?addAccount=1&reauth=second-account&server=/);
});

test('mobile: tapping an account identity switches to that account', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/profile');
  await expect(page.getByRole('button', { pressed: true })).toBeDisabled();
  await page.getByText('Second', { exact: true }).tap();
  await expect(page).toHaveURL(/\/rooms$/);
  expect(
    await page.evaluate(() =>
      window.__e2eCommandPayloads.filter((c) => c.type === 'switch_account')
    )
  ).toEqual([{ type: 'switch_account', account_id: 'second-account' }]);
});

test('mobile: account options do not select the account', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/profile');
  const dismiss = page.getByRole('button', { name: 'Close', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole('button', { name: 'More options: @second:example.test', exact: true }).tap();
  await expect(page.getByRole('menuitem', { name: 'Remove account' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.__e2eCommandPayloads.filter((c) => c.type === 'switch_account')
    )
  ).toEqual([]);
  await expect(page).toHaveURL(/\/profile$/);
  await page.getByRole('menuitem', { name: 'Remove account' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Remove this account?' });
  await expect(confirmation.getByText('Second', { exact: true })).toBeVisible();
  await expect(confirmation.getByText('@second:example.test', { exact: true })).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
});

test('mobile: switching shows progress and a failed switch can be retried', async ({
  page,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    window.__e2eSwitchAccountDelayMs = 1500;
    window.__e2eSwitchAccountError = true;
  });
  await installRoomCore('ready');
  await page.goto('/profile');
  const account = page.getByRole('button', {
    name: 'Switch account: Second, @second:example.test',
    exact: true,
  });
  await expect(account).toBeVisible();
  const dismiss = page.getByRole('button', { name: 'Close', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await account.click();
  await expect(account).toHaveAttribute('aria-busy', 'true');
  await expect(account.getByText('Switching…', { exact: true })).toBeVisible();
  await expect(account).toBeDisabled();
  await expect(page.locator('.account-list').getByRole('alert')).toHaveText(
    'Could not switch accounts. Try again.'
  );
  await expect(account).toBeEnabled();
  await expect(account).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { pressed: true })).toHaveAccessibleName(
    'Active account: E2E User, @e2e:example.test'
  );
  await page.evaluate(() => {
    window.__e2eSwitchAccountError = false;
    window.__e2eSwitchAccountDelayMs = 0;
  });
  await account.click();
  await expect(page).toHaveURL(/\/rooms$/);
  expect(
    await page.evaluate(() =>
      window.__e2eCommandPayloads.filter((c) => c.type === 'switch_account')
    )
  ).toEqual([
    { type: 'switch_account', account_id: 'second-account' },
    { type: 'switch_account', account_id: 'second-account' },
  ]);
});

test('mobile: custom profile colors keep a distinct avatar and touch controls are at least 48px', async ({
  page,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      hero_color: '#875394',
      display_name: 'Taylor',
    };
  });
  await installRoomCore('ready');
  await page.goto('/profile');
  const card = page.locator('.profile-card');
  await expect(card).toHaveClass(/tinted/);
  expect(
    await card
      .locator('.avatar-fallback')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
  ).not.toBe(await card.evaluate((element) => getComputedStyle(element).backgroundColor));
  expect(
    (await card.locator('.profile-card-user-id').boundingBox())?.height
  ).toBeGreaterThanOrEqual(48);
  await page.locator('.status-bubble').click();
  const dialog = page.getByRole('dialog');
  for (const target of [
    dialog.locator('.bottom-sheet-handle'),
    dialog.getByRole('textbox', { name: 'Status message' }),
    dialog.getByRole('button', { name: 'Cancel', exact: true }).first(),
  ]) {
    expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  }
});
