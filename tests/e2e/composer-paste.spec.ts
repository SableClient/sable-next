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

for (const slow of [false, true]) {
  test(`pasting a URL into the plain composer ${slow ? 'sends despite a slow preview' : 'bundles the preview'}`, async ({
    page,
    context,
    app,
    timeline,
    installRoomCore,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
    const url = 'https://example.test/article';
    await page.addInitScript(
      (delay) => {
        localStorage.setItem(
          'sable-preferences',
          JSON.stringify({ urlPreviews: true, encryptedUrlPreviews: true, richTextComposer: false })
        );
        window.__e2eUrlPreviewDelayMs = delay;
      },
      slow ? 10_000 : 0
    );
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installRoomCore('ready');
    await app.openRooms();
    await app.openRoomFromList('General');
    await timeline.expectRevealed();
    await app.composer.focus();
    await page.evaluate((text) => navigator.clipboard.writeText(text), url);
    await page.keyboard.press('ControlOrMeta+V');

    const loading = page.getByText('Loading link preview…', { exact: true });
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(page.locator('.preview-url')).toBeVisible();
    if (slow) {
      await expect(loading).toBeVisible();
      await expect(send).toBeEnabled();
    }
    await app.composer.press('Enter');
    if (slow) {
      await expect(send).toHaveAttribute('aria-busy', 'true');
      await expect(loading).toBeHidden();
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__e2eCalls.findLast((call) => call.method === 'messages.send')?.params
        )
      )
      .toMatchObject({
        body: url,
        formatted: null,
        link_previews: [
          expect.objectContaining({ url, title: slow ? null : 'The Example Article' }),
        ],
      });
    await expect(send).not.toHaveAttribute('aria-busy', 'true');
    expect(
      await page.evaluate(
        () => window.__e2eCalls.filter((call) => call.method === 'messages.url_preview').length
      )
    ).toBe(1);
  });
}
