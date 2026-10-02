import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

test('the composer controls fit beside the sidebar footer', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  const composer = await page.locator('.composer-after').first().boundingBox();
  const tools = await page.getByRole('navigation', { name: 'Quick tools' }).boundingBox();
  if (!composer || !tools) throw new Error('The composer and the sidebar footer are not laid out.');

  expect(composer.y).toBeGreaterThanOrEqual(tools.y);
  expect(composer.y + composer.height).toBeLessThanOrEqual(tools.y + tools.height);
});
