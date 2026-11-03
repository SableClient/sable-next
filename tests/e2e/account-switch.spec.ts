import { expect, test } from '@playwright/test';
import { installFakeCore } from './fake-core';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

declare global {
  interface Window {
    __e2eRoomViewsMounted?: number;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__e2eAccounts = [
      {
        account_id: 'e2e-account',
        user_id: '@e2e:example.test',
        device_id: 'E2EDEVICE',
        homeserver: 'https://example.test',
        needs_reauth: false,
      },
      {
        account_id: 'second-account',
        user_id: '@second:example.test',
        device_id: 'SECONDDEVICE',
        homeserver: 'https://example.test',
        needs_reauth: false,
      },
    ];
  });
  await installFakeCore(page, 'spaces');
});

test('switching account leaves the open room without showing it to the next account', async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto('/rooms/!room%3Aexample.test');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible({
    timeout: COLD_BOOT_TIMEOUT,
  });
  await expect(page.getByRole('treeitem', { name: 'Alpha' })).toBeVisible();
  await page.evaluate(() => {
    window.__e2eRoomViewsMounted = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('.room-view, :has(.room-view)')) {
            window.__e2eRoomViewsMounted = (window.__e2eRoomViewsMounted ?? 0) + 1;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.getByRole('button', { name: 'Switch account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Switch account' }).click();
  await page.getByRole('menuitemradio', { name: /@second:example\.test/ }).click();

  await expect(page).toHaveURL(/\/rooms$/);
  expect(await page.evaluate(() => window.__e2eRoomViewsMounted)).toBe(0);
  await expect(page.getByRole('treeitem', { name: 'Alpha' })).toBeHidden();
  expect(errors).toEqual([]);
});
