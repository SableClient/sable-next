import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({
  storageState: SIGNED_OUT,
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test('mobile emote autocomplete keeps the editor focused and keyboard spacing stable', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('missing visual viewport');
    Object.defineProperty(viewport, 'height', { get: () => window.innerHeight - 300 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveCSS('--keyboard-height', '300px');
  await app.composer.fill(':smi');
  const option = page.getByRole('option').last();
  await expect(option).toBeVisible();
  const count = await page.getByRole('option').count();
  for (let index = 1; index < count; index++) await app.composer.press('ArrowDown');
  await app.composer.evaluate((node) => {
    node.addEventListener('blur', () => {
      node.setAttribute('data-blurred', 'true');
    });
  });
  await option.tap();
  await expect(app.composer).not.toHaveText(':smi');
  await expect(app.composer).toBeFocused();
  await expect(app.composer).not.toHaveAttribute('data-blurred', 'true');
  await expect(page.locator('html')).toHaveCSS('--keyboard-height', '300px');
  const bottom = await page
    .locator('.composer')
    .evaluate((node) => node.getBoundingClientRect().bottom);
  const visibleBottom = await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('missing visual viewport');
    return viewport.height;
  });
  expect(bottom).toBeLessThanOrEqual(visibleBottom);
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
});
