import { expect, test, SIGNED_OUT } from './fixtures/test';

for (const mobile of [false, true]) {
  test.describe(mobile ? 'mobile profile status' : 'desktop profile status', () => {
    test.use({
      storageState: SIGNED_OUT,
      hasTouch: mobile,
      viewport: mobile ? { width: 412, height: 915 } : { width: 1280, height: 800 },
    });

    test('a long status can be scrolled to its end', async ({ app, page, installRoomCore }) => {
      await page.addInitScript(() => {
        (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
          status: { text: 'A long status that wraps onto several lines. '.repeat(30), emoji: '💬' },
        };
      });
      await installRoomCore('ready');
      await app.openRoom('!room:example.test');
      await page.getByRole('button', { name: "Open Alice's profile" }).last().click();
      const status = page.locator('.profile-card-status');
      await expect(status).toBeVisible();

      expect(await status.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
        await status.evaluate((element) => element.clientHeight)
      );
      await status.hover();
      await page.mouse.wheel(0, 1000);
      await expect.poll(() => status.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

      await status.focus();
      await page.keyboard.press('Control+End');
      await expect
        .poll(() =>
          status.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop
          )
        )
        .toBeLessThanOrEqual(1);
    });
  });
}
