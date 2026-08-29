import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.beforeEach(async ({ app, installRoomCore, page }) => {
  await installRoomCore('ready');
  await app.openHome();
  await page.goto('/settings/notifications');
  await expect(page.getByLabel('Add a keyword')).toBeVisible();
});

function fields(page: import('@playwright/test').Page) {
  return {
    input: page.getByLabel('Add a keyword'),
    add: page.locator('.keyword-form').getByRole('button', { name: 'Add', exact: true }),
  };
}

function removeButton(page: import('@playwright/test').Page, keyword: string) {
  return page.getByRole('button', { name: `Remove keyword ${keyword}` });
}

test('adding a keyword lists it', async ({ page }) => {
  const { input, add } = fields(page);

  await expect(page.getByText('No keywords yet.')).toBeVisible();

  await input.fill('urgent');
  await add.click();

  await expect(page.locator('.keyword-list li').filter({ hasText: 'urgent' })).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(page.getByText('No keywords yet.')).toHaveCount(0);
});

test('a blank keyword cannot be added', async ({ page }) => {
  const { add } = fields(page);

  await expect(add).toBeDisabled();
});

test('a duplicate keyword cannot be added', async ({ page }) => {
  const { input, add } = fields(page);

  await input.fill('urgent');
  await add.click();
  await expect(page.locator('.keyword-list li').filter({ hasText: 'urgent' })).toBeVisible();

  await input.fill('urgent');
  await expect(add).toBeDisabled();
});

test('removing a keyword drops it', async ({ page }) => {
  const { input, add } = fields(page);

  await input.fill('urgent');
  await add.click();
  await expect(page.locator('.keyword-list li').filter({ hasText: 'urgent' })).toBeVisible();

  await removeButton(page, 'urgent').click();

  await expect(page.locator('.keyword-list li').filter({ hasText: 'urgent' })).toHaveCount(0);
  await expect(page.getByText('No keywords yet.')).toBeVisible();
});

test('a server failure adding a keyword leaves the list showing what the server has', async ({
  page,
}) => {
  const { input, add } = fields(page);

  await input.fill('network-fail');
  await add.click();

  await expect(page.getByText('That keyword could not be added.')).toBeVisible();
  await expect(page.locator('.keyword-list li').filter({ hasText: 'network-fail' })).toHaveCount(0);
  await expect(page.getByText('No keywords yet.')).toBeVisible();
});

test('a server failure removing a keyword leaves it in the list', async ({ page }) => {
  const { input, add } = fields(page);

  await input.fill('stuck-keyword');
  await add.click();
  await expect(page.locator('.keyword-list li').filter({ hasText: 'stuck-keyword' })).toBeVisible();

  await removeButton(page, 'stuck-keyword').click();

  await expect(page.getByText('That keyword could not be removed.')).toBeVisible();
  await expect(page.locator('.keyword-list li').filter({ hasText: 'stuck-keyword' })).toBeVisible();
});
