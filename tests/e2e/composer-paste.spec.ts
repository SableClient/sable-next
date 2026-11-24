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
  await page.keyboard.press('ControlOrMeta+V');
  await expect(app.composer).toBeFocused();

  await expect.poll(() => app.composer.innerText()).toBe('pasted from nowhere');
});

test('a URL pasted into the plain composer previews in the draft and on send', async ({
  page,
  context,
  app,
  timeline,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
  const url = 'https://example.test/article';
  await page.addInitScript(() => {
    localStorage.setItem(
      'sable-preferences',
      JSON.stringify({ urlPreviews: true, encryptedUrlPreviews: true, richTextComposer: false })
    );
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await app.composer.focus();
  await page.evaluate((text) => navigator.clipboard.writeText(text), url);
  await page.keyboard.press('ControlOrMeta+V');

  await expect(page.locator('.preview-url')).toBeVisible();
  await app.composer.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__e2eCalls.findLast((call) => call.method === 'messages.send')?.params
      )
    )
    .toMatchObject({
      body: url,
      formatted: null,
      link_previews: [expect.objectContaining({ url, title: 'The Example Article' })],
    });
});
