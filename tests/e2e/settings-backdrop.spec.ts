import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('settings opens over the room that was switched to', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await expect(page.locator('.room-header')).toContainText('General');

  await app.roomLink('Random').click();
  await expect(page).toHaveURL(/!second/);
  await expect(page.locator('.room-header')).toContainText('Random');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();

  await expect(page.locator('.room-header')).toContainText('Random');
});

test('settings opens over a permalink without dropping the anchor', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openPermalink('!room:example.test', '$general-5:example.test');
  await expect(page).toHaveURL(/event=/);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(page.locator('.room-header')).toContainText('General');

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/event=/);
});
