import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('unicode emoji in the board are not clipped', async ({ page, app, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.locator('.composer').getByRole('button', { name: /emot/i }).first().click();

  const glyph = page.locator('.unicode-text').first();
  await expect(glyph).toBeVisible();
  const box = await glyph.evaluate((node) => ({
    height: node.clientHeight,
    content: node.scrollHeight,
  }));
  expect(box.content).toBeLessThanOrEqual(box.height);
});
