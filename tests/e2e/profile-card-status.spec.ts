import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, app, installRoomCore }) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      status: {
        text: 'A long status that needs scrolling to read in full. '.repeat(30),
        emoji: '💭',
      },
    };
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('button', { name: "Open Alice's profile" }).last().click();
});

test('a hovered status leaves the message action clickable', async ({ page }) => {
  await page.locator('.profile-card-user-id').focus();
  await page.locator('.profile-card-status').hover();
  await page.getByRole('button', { name: 'Message', exact: true }).click();
  await expect(page.locator('.profile-card')).toBeHidden();
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, viewport: { width: 412, height: 915 } });

  test('mobile: opening a chat from the profile sheet lands on the direct message', async ({
    page,
  }) => {
    await page.getByRole('dialog').getByRole('button', { name: 'Open chat' }).click();
    await expect(page).toHaveURL(/\/direct\/!dm%3Aexample\.test$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
