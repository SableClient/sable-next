import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('frequently used keeps custom emotes and text reactions inside their cells', async ({
  page,
  app,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'sable-recent-reactions',
      JSON.stringify([
        { emoji: 'mxc://example.test/partyparrot', total: 3 },
        { emoji: 'this is a long text reaction', total: 2 },
        { emoji: '🔥', total: 1 },
      ])
    );
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  await page.getByRole('button', { name: 'Emotes and stickers' }).click();
  const recents = page.locator('#emoji-recent [role="gridcell"]');
  await expect(recents.first()).toBeVisible();

  await expect(recents.nth(0).locator('.unicode-image')).toHaveCount(1);
  const overflowing = await recents.evaluateAll(
    (cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length
  );
  expect(overflowing).toBe(0);

  const clippedGlyphs = await page
    .locator('#emoji-people .unicode-text')
    .evaluateAll(
      (glyphs) => glyphs.filter((glyph) => glyph.scrollWidth > glyph.clientWidth + 1).length
    );
  expect(clippedGlyphs).toBe(0);
});
