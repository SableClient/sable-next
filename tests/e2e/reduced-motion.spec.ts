import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('defaults to on when the OS prefers reduced motion', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.openRooms();

  await expect(app.primaryNavigation).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on');
});

test('defaults to off when the OS has no preference', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.openRooms();

  await expect(app.primaryNavigation).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'off');
});

test('enabling it in settings sets the attribute on the document element', async ({
  page,
  app,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.openRooms();
  await page.goto('/settings/accessibility');

  const toggle = page.getByRole('switch', { name: 'Reduce motion' });
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'off');

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on');

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'off');
});
