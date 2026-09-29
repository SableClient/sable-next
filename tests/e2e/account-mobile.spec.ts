import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

test('mobile: the account page with a banner fits the screen', async ({
  page,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      banner_url: 'mxc://example.test/history-image',
    };
  });
  await installRoomCore('ready');
  await page.goto('/settings/account');
  await expect(page.locator('.profile-preview')).toBeVisible();
  await expect(page.locator('.banner-setting')).toBeVisible();

  const overflowing = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll('.settings-scroll *')]
      .filter((node) => node.getBoundingClientRect().right > width + 1)
      .map((node) => node.className);
  });
  expect(overflowing).toEqual([]);
});

test('mobile: a long blocked user ID stays inside its settings section', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/settings/account');

  await page.getByPlaceholder('@user:example.org').fill(`@${'a'.repeat(160)}:example.org`);
  await page.getByRole('button', { name: 'Block', exact: true }).click();

  const list = page.locator('.ignored-users');
  await expect(list).toBeVisible();
  expect(
    await list.evaluate((element) => {
      const section = element.closest('section');
      return section !== null && section.scrollWidth <= section.clientWidth;
    })
  ).toBe(true);
});

for (const pageZoom of [1, 1.25]) {
  test(`mobile: the account page fits a 375px screen at ${String(pageZoom * 100)}% zoom (#473)`, async ({
    page,
    installRoomCore,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript((zoom) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ pageZoom: zoom }));
      (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
        banner_url: 'mxc://example.test/wide-banner',
        avatar_url: 'mxc://example.test/wide-avatar',
      };
    }, pageZoom);
    await installRoomCore('ready');
    await page.goto('/settings/account');
    await expect(page.locator('.profile-preview')).toBeVisible();
    await expect(page.locator('.banner-setting')).toBeVisible();

    const overflowing = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll('.settings-scroll *')]
        .filter((node) => node.getBoundingClientRect().right > width + 1)
        .map((node) => node.className);
    });
    expect(overflowing).toEqual([]);
  });
}
