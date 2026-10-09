import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('a room can be reported from its menu', async ({ app, page, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Report room' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report room' });
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Spam everywhere');
  await page.screenshot({ path: `test-results/report-room-${test.info().project.name}.png` });
  await dialog.getByRole('button', { name: 'Report' }).click();

  await expect(page.getByText('Report sent')).toBeVisible();
});

test('the media preview setting is offered in privacy settings', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  await page.goto('/settings/privacy');
  await expect(page.getByRole('switch', { name: 'Avatars on invites' })).toBeChecked({
    timeout: 15_000,
  });
  await page.screenshot({
    path: `test-results/media-privacy-${test.info().project.name}.png`,
    fullPage: false,
  });
});
