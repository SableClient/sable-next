import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
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

test('typing filters settings by their name across categories', async ({ page }) => {
  await searchField(page).fill('autoplay');

  const results = resultsList(page).getByRole('listitem');
  await expect(results).toHaveCount(1);
  await expect(results.filter({ hasText: 'Autoplay GIFs' })).toBeVisible();
  await expect(results.filter({ hasText: 'In Media' })).toBeVisible();
});

test('typing matches on the translated description, not just the name', async ({ page }) => {
  await searchField(page).fill('operating system');

  const results = resultsList(page).getByRole('listitem');
  await expect(results).toHaveCount(1);
  await expect(results.filter({ hasText: 'System notifications' })).toBeVisible();
  await expect(results.filter({ hasText: 'In Notifications' })).toBeVisible();
});

test('the summary reports how many results there are', async ({ page }) => {
  await searchField(page).fill('notification');

  const count = await resultsList(page).getByRole('listitem').count();
  expect(count).toBeGreaterThan(1);
  await expect(page.getByText(`${String(count)} results`)).toBeVisible();

  await searchField(page).fill('autoplay');
  await expect(page.getByText('1 result', { exact: true })).toBeVisible();
});

test('a query matching nothing says so', async ({ page }) => {
  await searchField(page).fill('zzzznothingmatchesthis');

  await expect(resultsList(page).getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('No settings match')).toBeVisible();
});

test('activating a result lands in the right category and highlights the setting', async ({
  page,
}) => {
  await searchField(page).fill('clear notifications');

  await resultsList(page)
    .getByRole('link')
    .filter({ hasText: 'Clear notifications when read' })
    .click();

  await expect(page).toHaveURL(/\/settings\/notifications\?focus=clear-notifications-on-read/);
  await expect(page.getByRole('switch', { name: 'Clear notifications when read' })).toBeVisible();
  await expect(page.locator('[data-settings-focus="clear-notifications-on-read"]')).toHaveClass(
    /highlighted/
  );
  await expect
    .poll(() => page.locator('.settings-scroll').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
});
