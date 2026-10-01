import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, keepUnverifiedBanner: true });

test('quick reaction autocomplete selects with Enter or Tab', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  for (const key of ['Enter', 'Tab']) {
    await app.composer.fill('+:joy');
    await expect(page.getByRole('option', { name: ':joy:', exact: true })).toBeVisible();
    await app.composer.press(key);
    await expect(app.composer).toHaveText('');
    await expect(page.getByRole('listbox')).toBeHidden();
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.__e2eCommands.filter((command) => command === 'react').length)
    )
    .toBe(2);
  expect(await page.evaluate(() => window.__e2eCommands.includes('send_message'))).toBe(false);
});

test('mobile quick reaction autocomplete selects by touch', async ({
  page,
  app,
  timeline,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await app.composer.fill('+:');
  await expect(page.getByRole('option').first()).toBeVisible();
  await app.composer.fill('+:joy');
  await page.getByRole('option', { name: ':joy:', exact: true }).tap();
  await expect(app.composer).toHaveText('');
  await expect.poll(() => page.evaluate(() => window.__e2eCommands.includes('react'))).toBe(true);
  expect(await page.evaluate(() => window.__e2eCommands.includes('send_message'))).toBe(false);
});

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

  const picked = await options.nth(1).locator('.unicode-emoji').textContent();
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
