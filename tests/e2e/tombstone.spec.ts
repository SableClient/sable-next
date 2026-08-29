import { expect, test } from './fixtures/test';

test('a tombstoned room replaces the composer with a banner offering the successor', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('tombstoned');
  await app.openHome();
  await app.openRoomFromList('Old Room');

  await expect(page.getByRole('region', { name: 'This room has been replaced' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Send a message...' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open new room' }).click();
  await expect(page).toHaveURL(/\/rooms\/!successor%3Aexample\.test$/);
});
