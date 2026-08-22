import { expect, test } from './fixtures/test';

test('a room this account cannot post in offers an empty box, not a composer', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();

  await app.openRoomFromList('General');
  const writable = await page.locator('.composer').boundingBox();

  await app.openRoomFromList('Random');
  await expect(page.locator('.composer .locked')).toHaveText(
    'You do not have permission to post in this room'
  );
  const readOnly = await page.locator('.composer').boundingBox();

  await expect(page.locator('.composer button')).toHaveCount(0);
  await expect(page.locator('[role="combobox"]')).toHaveCount(0);
  expect(readOnly?.height).toBe(writable?.height);
});
