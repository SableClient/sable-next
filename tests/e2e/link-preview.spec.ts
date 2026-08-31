import { expect, test, SIGNED_OUT } from './fixtures/test';

const ARTICLE = 'https://example.test/article';

const PREVIEW = {
  'og:url': ARTICLE,
  'og:title': 'The Example Article',
  'og:description': 'A short description of the article.',
  'og:site_name': 'Example',
};

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a message with a link renders a preview when link previews are enabled', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ urlPreviews: true }));
  });
  homeserverProxy.respond(/GET \/_matrix\/(media|client)\/[^ ]*preview_url/, PREVIEW, {
    times: 10,
  });

  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Link on ${String(Date.now())}` });
  await account.sendMessage(roomId, `Check this out ${ARTICLE}`);

  await app.openRoom(roomId);
  await timeline.expectRevealed();

  const preview = page.locator('.link-preview');
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toHaveAttribute('href', ARTICLE);
  await expect(preview.locator('.link-preview-title')).toHaveText('The Example Article');
  await expect(preview.locator('.link-preview-site')).toHaveText('Example');
});

test('a message with a link renders nothing when link previews are disabled', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  const account = await proxiedLogin();
  const roomId = await account.createRoom({ name: `Link off ${String(Date.now())}` });
  const body = `Check this out ${ARTICLE}`;
  await account.sendMessage(roomId, body);

  await app.openRoom(roomId);
  await timeline.expectRevealed();

  await expect(timeline.message(body)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.link-preview')).toHaveCount(0);
  expect(homeserverProxy.count(/preview_url/)).toBe(0);
});
