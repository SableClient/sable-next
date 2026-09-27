import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('unicode emoji in the board are not clipped', async ({ page, app, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('button', { name: en.composer.emotesAndStickers, exact: true }).click();

  const glyph = page.locator('.unicode-text').first();
  await expect(glyph).toBeVisible();
  const box = await glyph.evaluate((node) => ({
    height: node.clientHeight,
    content: node.scrollHeight,
  }));
  expect(box.content).toBeLessThanOrEqual(box.height);
});
