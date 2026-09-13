import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

const SECTIONS = [
  'General',
  'Members',
  'Permissions',
  'Abbreviations',
  'Emojis & stickers',
  'Developer tools',
];

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'More options' }).click();
  const menu = page.getByRole('dialog', { name: 'More options' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = page.locator('.dialog-content-settings');
  await expect(settings).toBeVisible();
  return settings;
}

test('mobile: the room menu hands the settings dialog its back entry', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  const settings = await openSettings(page);
  await page.waitForTimeout(1_000);
  await expect(settings).toBeVisible();
});

test('mobile: no room settings section is wider than the screen', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const settings = await openSettings(page);

  for (const name of SECTIONS) {
    await settings.getByRole('button', { name, exact: true }).first().click();
    await expect(settings.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await page.waitForTimeout(500);

    const overflowing = await page.evaluate(() => {
      const root = document.querySelector('.dialog-content-settings');
      if (!root) return ['the settings dialog closed itself'];
      const limit = root.clientWidth;
      return [...root.querySelectorAll('*')]
        .filter((node) => !node.closest('.screen-reader-only'))
        .filter((node) => node.scrollWidth > limit + 1)
        .map((node) => `${node.tagName}.${node.className} ${node.scrollWidth}/${limit}`)
        .slice(0, 4);
    });
    expect(overflowing, `${name} overflows`).toEqual([]);

    await settings.getByRole('button', { name: 'Back', exact: true }).click();
  }
});
