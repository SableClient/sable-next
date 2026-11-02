import { expect, test as setup } from '@playwright/test';

import { installFakeCore } from './fake-core';

// A cold dev server compiles the app and re-bundles dependencies on the first page load, which
// takes longer than a test's assertion timeout.
setup('the dev server has compiled the app', async ({ page }) => {
  setup.setTimeout(180_000);
  await installFakeCore(page, 'ready');
  for (const path of ['/rooms', '/profile']) {
    await page.goto(path);
    await expect(page.locator('main').first()).toBeVisible({ timeout: 120_000 });
  }
});
