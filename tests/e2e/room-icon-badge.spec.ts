import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

for (const showRoomIcon of ['always', 'never']) {
  test(`the join-rule badge glyph fills its disc with room icons set to ${showRoomIcon}`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.addInitScript((showRoomIcon) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ showRoomIcon }));
    }, showRoomIcon);
    await installRoomCore('ready');
    await app.openRooms();
    const badge = page.locator('.room-icon-badge').first();
    await expect(badge).toBeVisible();
    const disc = await badge.boundingBox();
    const glyph = await badge.locator('svg').boundingBox();
    expect(glyph).toEqual(disc);
  });
}
