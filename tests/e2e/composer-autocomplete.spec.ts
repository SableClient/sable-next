import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, keepUnverifiedBanner: true });

test('the arrow keys move a visible highlight through emote suggestions', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await app.composer.click();
  await page.keyboard.type(':sm');
  const options = page.locator('[role="option"]');
  await expect(options.nth(1)).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  const [row, panel] = await options
    .nth(1)
    .evaluate((node) => [
      getComputedStyle(node).backgroundColor,
      getComputedStyle(node.closest('.autocomplete') ?? node).backgroundColor,
    ]);
  expect(row).not.toBe(panel);

  const picked = await options.nth(1).locator('.label').textContent();
  await page.keyboard.press('Enter');
  await expect(app.composer).toContainText(picked ?? '');
});

test('an open suggestion list is not covered by the banners', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  const banner = page.getByText('One of your devices is not verified');
  await expect(banner).toBeVisible();

  await app.composer.click();
  await page.keyboard.type(':sm');
  await expect(page.locator('[role="option"]').first()).toBeVisible();
  await expect(banner).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(banner).toBeVisible();
});
