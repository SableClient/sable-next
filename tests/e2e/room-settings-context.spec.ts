import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

for (const path of ['/rooms', '/rooms/!room%3Aexample.test']) {
  test(`app settings open from ${path}`, async ({ page, installRoomCore }) => {
    await installRoomCore('ready');
    await page.goto(path);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();

    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Account', exact: true }).first()).toBeVisible();
  });
}

test('room settings open from the rooms list without a space', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await page
    .locator('.room-row-wrap a[href="/rooms/!room%3Aexample.test"]')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();

  const settings = page.locator('.dialog-content-settings');
  await expect(
    settings.getByRole('heading', { name: 'General', exact: true }).last()
  ).toBeVisible();
});
