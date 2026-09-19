import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

test('mobile: the profile card keeps its actions inside the card', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Your presence' })).toBeVisible();

  const cardBox = await page.locator('.profile-card').boundingBox();
  const actionsBox = await page.locator('.profile-card-actions').boundingBox();
  if (!cardBox || !actionsBox) throw new Error('The profile card is not laid out.');
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
});
