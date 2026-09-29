import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

test('mobile: the profile card keeps its actions inside the card', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();

  const cardBox = await page.locator('.profile-card').boundingBox();
  const actionsBox = await page.locator('.profile-card-actions').boundingBox();
  const coverBox = await page.locator('.profile-card-cover').boundingBox();
  const statusBox = await page.locator('.status-bubble').boundingBox();
  const nameBox = await page.locator('.profile-card-name').boundingBox();
  if (!cardBox || !actionsBox || !coverBox || !statusBox || !nameBox) {
    throw new Error('The profile card is not laid out.');
  }
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
  expect(statusBox.y).toBeLessThan(coverBox.y + coverBox.height);
  expect(statusBox.y + statusBox.height).toBeGreaterThan(coverBox.y + coverBox.height);
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(nameBox.y);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
});
