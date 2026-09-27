import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

test('mobile: the account page with a banner fits the screen', async ({
  page,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      banner_url: 'mxc://example.test/history-image',
    };
  });
  await installRoomCore('ready');
  await page.goto('/settings/account');
  await expect(page.locator('.profile-preview')).toBeVisible();
  await expect(page.locator('.banner-setting')).toBeVisible();

  const overflowing = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll('.settings-scroll *')]
      .filter((node) => node.getBoundingClientRect().right > width + 1)
      .map((node) => node.className);
  });
  expect(overflowing).toEqual([]);
});
