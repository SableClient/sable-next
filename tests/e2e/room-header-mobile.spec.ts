import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 375, height: 812 } });

test('mobile: the room header keeps search and the menu, the rest moves into the menu', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  const header = page.locator('.room-header');
  await expect(header.getByRole('button', { name: en.search.open })).toBeVisible();
  await expect(header.getByRole('button', { name: 'More options' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Members' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Threads' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Pinned messages' })).toHaveCount(0);
  await expect(header.locator('h1')).toBeVisible();
  const title = await header.locator('h1').boundingBox();
  expect(title?.width ?? 0).toBeGreaterThan(120);
  await page.screenshot({ path: 'test-results/room-header-mobile.png' });

  await header.getByRole('button', { name: 'More options' }).click();
  const menu = page.getByRole('dialog', { name: 'More options' });
  await expect(menu.getByRole('menuitem', { name: 'Members' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Threads' })).toBeVisible();
  await page.screenshot({ path: 'test-results/room-header-mobile-menu.png' });

  await menu.getByRole('menuitem', { name: /Pinned messages/ }).click();
  await expect(page.getByRole('dialog', { name: 'Pinned messages' })).toBeVisible();
});
