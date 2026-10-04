import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({
  storageState: SIGNED_OUT,
  hasTouch: true,
  viewport: { width: 412, height: 915 },
});

const historyLength = (page: Page): Promise<number> => page.evaluate(() => history.length);

async function pickRoom(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
  await expect(page.locator('#drawer-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name }).click();
  await expect(page.locator('#drawer-toggle')).toHaveAttribute('aria-pressed', 'false');
}

test('mobile: switching rooms from the list replaces the entry, so back leaves the stack', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/rooms');
  await page.getByRole('link', { name: /^General/ }).click();
  await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
  const general = page.url();
  const length = await historyLength(page);

  await pickRoom(page, /^Random/);
  expect(page.url()).not.toBe(general);
  await pickRoom(page, /^General/);
  await pickRoom(page, /^Random/);
  expect(await historyLength(page)).toBe(length);

  await page.goBack();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('mobile: a settings section pops to the menu, and close returns to the page that opened settings', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/rooms');
  await page.getByRole('link', { name: /^General/ }).click();
  await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
  await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
  await page.getByRole('link', { name: 'Manage accounts' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('link', { name: 'Timeline' }).click();
  await expect(page).toHaveURL(/\/settings\/timeline$/);
  const length = await historyLength(page);

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(await historyLength(page)).toBe(length);

  await page.getByRole('link', { name: 'Timeline' }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
});
