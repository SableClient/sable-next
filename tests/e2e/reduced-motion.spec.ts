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
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--duration-medium').trim()
      )
    )
    .toBe('0s');
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
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--duration-fast').trim()
      )
    )
    .toBe('0s');
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--duration-medium').trim()
      )
    )
    .toBe('0s');
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim()
      )
    )
    .toBe('0s');
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const thumb = document.querySelector('.switch-thumb');
        if (!thumb) return '';
        return getComputedStyle(thumb)
          .transitionDuration.split(',')
          .map((part) => part.trim())
          .every((part) => part === '0s')
          ? '0s'
          : getComputedStyle(thumb).transitionDuration;
      })
    )
    .toBe('0s');

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'off');
});
