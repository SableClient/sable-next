import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.beforeEach(async ({ page }) => {
  await page.goto('/rooms');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
});

function searchField(page: import('@playwright/test').Page) {
  return page.getByRole('searchbox', { name: 'Search settings' });
}

function resultsList(page: import('@playwright/test').Page) {
  return page.getByRole('list', { name: 'Search settings' });
}

test('activating a result lands in the right category and highlights the setting', async ({
  page,
}) => {
  await searchField(page).fill('clear alerts');

  await resultsList(page).getByRole('link').filter({ hasText: 'Clear alerts when read' }).click();

  await expect(page).toHaveURL(/\/settings\/notifications\?focus=clear-notifications-on-read/);
  await expect(page.getByRole('switch', { name: 'Clear alerts when read' })).toBeVisible();
  await expect(page.locator('[data-settings-focus="clear-notifications-on-read"]')).toHaveClass(
    /highlighted/
  );
  await expect
    .poll(() => page.locator('.settings-scroll').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
});
