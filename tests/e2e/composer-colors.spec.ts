import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

async function colourSelection(page: Page, composer: ReturnType<Page['locator']>) {
  await page.getByRole('button', { name: 'Formatting', exact: true }).click();
  await composer.fill('red words');
  await composer.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Text colour' }).click();
  await page.screenshot({ path: `test-results/composer-colors-${test.info().project.name}.png` });
  await page.getByRole('button', { name: '#e5484d' }).click();
  await expect(composer).toHaveText('$[fg.color=e5484d red words]');
}

test.describe('desktop', () => {
  test.use({ storageState: SIGNED_OUT });

  test('the text colour picker colours the selection', async ({ app, page, installRoomCore }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await colourSelection(page, app.composer);

    await page.getByRole('button', { name: 'Highlight colour' }).click();
    await page.getByRole('textbox', { name: 'Hex colour' }).fill('#12a594');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(app.composer).toHaveText('$[fg.color=e5484d $[bg.color=12a594 red words]]');
  });
});

test.describe('mobile', () => {
  test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 375, height: 812 } });

  test('mobile: the text colour picker opens as a sheet', async ({
    app,
    page,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await colourSelection(page, app.composer);
  });
});
