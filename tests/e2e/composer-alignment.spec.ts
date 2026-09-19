import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

test('the composer sits on the same line as the sidebar footer', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  const composer = await page.locator('.composer').first().boundingBox();
  const tools = await page.getByRole('navigation', { name: 'Quick tools' }).boundingBox();
  if (!composer || !tools) throw new Error('The composer and the sidebar footer are not laid out.');

  const composerCentre = composer.y + composer.height / 2;
  const toolsCentre = tools.y + tools.height / 2;
  expect(Math.abs(composerCentre - toolsCentre)).toBeLessThanOrEqual(1);
});
