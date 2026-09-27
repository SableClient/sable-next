import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const SECTIONS = [
  'account',
  'emotes',
  'devices',
  'privacy',
  'personas',
  'appearance',
  'composer',
  'keyboard',
  'media',
  'timeline',
  'desktop',
  'notifications',
  'calls',
  'developer',
  'about',
];

for (const size of [{}, { pageZoom: 1.5, textScale: 1.5 }]) {
  test(`mobile: every settings section fits 375px at ${JSON.stringify(size)}`, async ({
    page,
    installRoomCore,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript((prefs) => {
      localStorage.setItem('sable-preferences', prefs);
      (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
        banner_url: 'mxc://example.test/wide-banner',
        avatar_url: 'mxc://example.test/wide-avatar',
      };
    }, JSON.stringify(size));
    await installRoomCore('ready');

    const escapes: Record<string, string[]> = {};
    for (const section of SECTIONS) {
      await page.goto(`/settings/${section}`);
      await expect(page.locator('.settings-scroll')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(500);
      const found = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const outside = (node: Element) => node.getBoundingClientRect().right > width + 1;
        return [...document.querySelectorAll('.settings-scroll *')]
          .filter((node) => outside(node) && node.parentElement && !outside(node.parentElement))
          .map((node) => `${node.tagName.toLowerCase()} "${node.textContent.trim().slice(0, 40)}"`);
      });
      if (found.length > 0) escapes[section] = found;
    }
    expect(escapes).toEqual({});
  });
}
