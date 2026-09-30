import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('touch: calendar room settings and members open from the header', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('calendar');
  await app.openRooms();
  await app.openRoomFromList('General');
  await expect(page.getByRole('main', { name: 'Calendar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Jump to time' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Members', exact: true }).click();
  const settings = page.locator('.dialog-content-settings');
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('searchbox', { name: /Search members/ })).toBeVisible();
  await expect(settings.getByText('Alice', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Close room settings' }).click();
  await expect(settings).toBeHidden();

  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', { name: 'General', exact: true })).toBeVisible();
});

test('touch: calendar room options open the existing room dialogs', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('calendar');
  await app.openRooms();
  await app.openRoomFromList('General');

  for (const [item, label, close] of [
    ['Invite', 'Invite', 'Close'],
    ['Report room', 'Report room', 'Cancel'],
    ['Leave room', 'Leave', 'Cancel'],
  ]) {
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: label, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: close, exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New event', exact: true })).toBeVisible();
});

test('touch: a read-only calendar still offers settings and members', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('calendar');
  await app.openRooms();
  await app.openRoomFromList('Random');
  await expect(page.getByRole('main', { name: 'Calendar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Invite', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Members', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.dialog-content-settings')).toBeVisible();
});
