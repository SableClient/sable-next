import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, keepUnverifiedBanner: true });

test('a docked banner takes the pointer across its whole card', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  const banner = page
    .getByRole('status')
    .filter({ hasText: 'One of your devices is not verified' });
  await expect(banner).toBeVisible();

  const card = await banner.boundingBox();
  const composer = await page.locator('.composer-dock').boundingBox();
  expect((card?.y ?? 0) + (card?.height ?? 0)).toBeLessThanOrEqual(composer?.y ?? 0);
  await app.composer.click({ timeout: 2000 });

  await banner.locator('.body').click({ clickCount: 3 });
  expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toContain('warning');

  await banner.getByRole('button', { name: 'Close' }).click({ timeout: 2000 });
  await expect(banner).toHaveCount(0);
});
