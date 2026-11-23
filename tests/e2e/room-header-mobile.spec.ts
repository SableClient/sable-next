import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 375, height: 812 } });

test('mobile: the room header keeps search and the menu, the rest moves into the menu', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  const header = page.locator('.room-header');
  await expect(header.getByRole('button', { name: en.common.searchMessages })).toBeVisible();
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

test('mobile text rooms in spaces put unread Threads in the header and calls in the menu', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('thread_discovery');
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ alwaysShowCallButton: true }));
  });
  await page.goto('/space/!alpha%3Aexample.test/!room%3Aexample.test');
  await expect(page.locator('.timeline-viewport:not(.initial)')).toBeVisible({
    timeout: COLD_BOOT_TIMEOUT,
  });
  const header = page.locator('.room-header');
  const threads = header.getByRole('button', { name: 'Threads, 2 unread threads' });
  await expect(threads).toBeVisible();
  await expect(header.getByRole('button', { name: en.call.start })).toHaveCount(0);

  await header.getByRole('button', { name: 'More options' }).click();
  const menu = page.getByRole('dialog', { name: 'More options' });
  await expect(menu.getByRole('menuitem', { name: en.call.start })).toBeVisible();
  await menu.press('Escape');
  await expect(menu).toBeHidden();
  await threads.click();

  const drawer = page.getByRole('dialog', { name: en.timeline.threadsTitle });
  const first = drawer.getByRole('listitem').first();
  await expect(first).toContainText('Release follow-up');
  await expect(first.locator('.thread-unread-count')).toBeVisible();
  await expect(first).toContainText('2 unread replies');
  await expect(first).toContainText('🚨');
  await expect(first).toContainText('✅');
  const second = drawer.getByRole('listitem').nth(1);
  await expect(second).toContainText('Welcome thread');
  await expect(second.locator('.thread-unread-dot')).toBeVisible();
  await expect(second).toContainText('New');
});
