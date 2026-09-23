import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('slash gif opens the picker', async ({ page, app, installRoomCore }) => {
  await page.route(/tenor|gifs\.sable\.moe|giphy|klipy/, (route) =>
    route.fulfill({ json: { results: [], data: [] } })
  );
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await app.composer.fill('/gif cats');
  await app.composer.press('Enter');
  const board = page.locator('.composer-board');
  await expect(board).toBeVisible();
  await expect(board).toBeInViewport();
});
