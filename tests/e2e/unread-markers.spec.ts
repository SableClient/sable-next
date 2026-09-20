import { expect, type Page, test } from '@playwright/test';

import { installFakeCore } from './fake-core';

test.beforeEach(async ({ page }) => {
  await installFakeCore(page, 'ready');
});

async function roomRow(page: Page, name: string) {
  const row = page.locator('.room-row', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  return row;
}

test('a mentions-only room with no mention still shows its unread marker', async ({ page }) => {
  await page.goto('/rooms');
  const row = await roomRow(page, 'Random');

  await expect(row.locator('.unread-badge')).toBeVisible();
  await expect(row).toHaveClass(/unread/);
});

test('a mentions-only room counts its mentions and not its other messages', async ({ page }) => {
  await page.goto('/rooms');
  const row = await roomRow(page, 'General');

  await expect(row.locator('.unread-badge-count')).toHaveText('1');
});
