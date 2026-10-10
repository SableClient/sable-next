import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('Ctrl+V pastes into the composer while nothing is focused', async ({
  page,
  context,
  app,
  timeline,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await page.evaluate(() => navigator.clipboard.writeText('pasted from nowhere'));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(app.composer).not.toBeFocused();
  await page.keyboard.press('Control+V');
  await expect(app.composer).toBeFocused();

  await expect.poll(() => app.composer.innerText()).toBe('pasted from nowhere');
});
