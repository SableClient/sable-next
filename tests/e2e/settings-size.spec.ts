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
  test(`mobile: every settings section fits 375px without splitting words at ${JSON.stringify(size)}`, async ({
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
    const splitWords: Record<string, string[]> = {};
    for (const section of SECTIONS) {
      await page.goto(`/settings/${section}`);
      await expect(page.locator('.settings-scroll')).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      const found = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const outside = (node: Element) => node.getBoundingClientRect().right > width + 1;
        return [...document.querySelectorAll('.settings-scroll *')]
          .filter((node) => outside(node) && node.parentElement && !outside(node.parentElement))
          .map((node) => `${node.tagName.toLowerCase()} "${node.textContent.trim().slice(0, 40)}"`);
      });
      if (found.length > 0) escapes[section] = found;
      const split = await page.evaluate(() =>
        [
          ...document.querySelectorAll('.setting-row .name, .setting-row .settings-description'),
        ].flatMap((node) => {
          const words: string[] = [];
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            for (const match of (text.textContent ?? '').matchAll(
              /(?<=^|\s)[A-Za-z]{4,}(?=\s|$)/g
            )) {
              const range = document.createRange();
              range.setStart(text, match.index);
              range.setEnd(text, match.index + match[0].length);
              const lines = new Set(
                [...range.getClientRects()].map((rect) => Math.round(rect.top))
              );
              if (lines.size > 1) words.push(match[0]);
            }
          }
          return words;
        })
      );
      if (split.length > 0) splitWords[section] = split;
    }
    expect(splitWords).toEqual({});
    expect(escapes).toEqual({});
  });
}
