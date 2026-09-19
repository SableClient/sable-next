import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const OFFSETS = [
  { name: 'no inset', top: '0px', decorations: null },
  { name: 'a notch', top: '48px', decorations: null },
  { name: 'the desktop title bar', top: '0px', decorations: 'desktop' },
];

for (const offset of OFFSETS) {
  test(`the skip link stays hidden under ${offset.name}`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await page.evaluate((decorations) => {
      if (decorations !== null) document.documentElement.dataset.clientDecorations = decorations;
    }, offset.decorations);
    await page.addStyleTag({
      content: `:root { --safe-area-inset-top: ${offset.top}; --safe-area-inset-left: 24px; }`,
    });

    const link = page.locator('.skip-link');
    const hidden = await link.boundingBox();
    expect(hidden?.width).toBeLessThanOrEqual(1);
    expect(hidden?.height).toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.skip-link')?.focus();
    });
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();

    const shown = await link.boundingBox();
    expect(shown?.y ?? 0).toBeGreaterThan(0);
    expect(shown?.x ?? 0).toBeGreaterThanOrEqual(24);

    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });
}
