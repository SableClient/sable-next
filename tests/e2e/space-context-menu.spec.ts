import type { Locator, Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

function rail(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Primary navigation' });
}

function railSpaces(page: Page): Locator {
  return rail(page).locator('.rail-slot a[href^="/space/"]');
}

function menu(page: Page): Locator {
  return page.locator('.room-options-menu');
}

test.beforeEach(async ({ page, spacesLogin }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await spacesLogin();
  await page.goto('/rooms');
  await expect(railSpaces(page)).toHaveCount(3, { timeout: 90_000 });
});

test('right-clicking a space opens its options, not the display menu', async ({ page }) => {
  await railSpaces(page).first().click({ button: 'right' });

  await expect(menu(page)).toHaveCount(1);
  await expect(menu(page).getByText('Mark as read')).toBeVisible();
  await expect(page.getByText('Room unread counts')).toHaveCount(0);
});

test('right-clicking a second space moves the menu to it', async ({ page }) => {
  const spaces = railSpaces(page);
  await spaces.nth(0).click({ button: 'right' });
  await expect(menu(page)).toHaveCount(1);
  const first = await menu(page).boundingBox();

  await spaces.nth(2).click({ button: 'right' });

  await expect(menu(page)).toHaveCount(1);
  const second = await menu(page).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second?.y).toBeGreaterThan((first?.y ?? 0) + 1);
});

test('the rail background opens the display menu at the pointer', async ({ page }) => {
  const separator = rail(page).locator('.rail-separator').first();
  const box = await separator.boundingBox();
  expect(box).not.toBeNull();
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  await separator.click({ button: 'right', force: true });

  const display = page.locator('.rail-display-menu');
  await expect(display).toBeVisible();
  const menuBox = await display.boundingBox();
  expect(Math.abs((menuBox?.y ?? 0) - y)).toBeLessThan(220);
});
