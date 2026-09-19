import type { Locator } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

function layer(surface: Locator): Promise<number> {
  return surface.evaluate((node) => Number(getComputedStyle(node).zIndex));
}

test('mobile: a dialog raised from the settings sheet takes the top', async ({
  page,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await installRoomCore('ready');
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav).toBeVisible();
  await nav.getByText('Per-Message Profiles').click();
  await page.getByRole('button', { name: 'New profile' }).click();

  const editor = page.locator('.dialog-content-settings');
  await expect(editor).toBeVisible();
  expect(await layer(editor)).toBeGreaterThan(await layer(page.locator('.dialog-content-sheet')));

  const name = editor.locator('input[name="persona-name"]');
  await name.fill('Nadia');
  await expect(name).toHaveValue('Nadia');
});

test('a menu opened inside a dialog takes the top', async ({ page, app, installRoomCore }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav).toBeVisible();
  await nav.getByText('Appearance', { exact: true }).click();

  const dialog = page.locator('.dialog-content-settings');
  await dialog.locator('[aria-haspopup="listbox"]').first().click();

  const menu = page.locator('.menu-surface');
  await expect(menu).toBeVisible();
  expect(await layer(menu)).toBeGreaterThan(await layer(dialog));
  await menu.locator('.menu-item').first().click();
});

test('the pin menu is portalled onto the overlay layer', async ({ page, app, installRoomCore }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('button', { name: 'Pinned messages' }).click();

  const menu = page.locator('.pin-menu');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((node) => node.closest('.room-header'))).toBe(null);
});
