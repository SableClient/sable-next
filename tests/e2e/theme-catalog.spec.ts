import { expect, test, type Locator } from '@playwright/test';

import { installFakeCore } from './fake-core';

const FILES = 'https://git.sable.moe/SableClient/themes/raw/branch/main/';
const NAMES = Array.from({ length: 60 }, (_, index) => `Theme ${String(index).padStart(2, '0')}`);

test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.route(`${FILES}**`, async (route) => {
    const url = route.request().url();
    if (url.endsWith('catalog.json')) {
      await route.fulfill({
        json: {
          themes: NAMES.map((name, index) => ({
            basename: name,
            previewUrl: null,
            fullUrl: `${FILES}themes/theme-${index}.sable.css`,
          })),
          tweaks: Array.from({ length: 30 }, (_, index) => ({
            basename: `Tweak ${String(index).padStart(2, '0')}`,
            previewUrl: null,
            fullUrl: `${FILES}tweaks/tweak-${index}.sable.css`,
          })),
        },
      });
      return;
    }
    if (url.includes('/tweaks/')) {
      const index = Number(/tweak-(\d+)/.exec(url)?.[1]);
      await route.fulfill({
        body: `/*\n@sable-tweak\nname: Tweak ${String(index).padStart(2, '0')}\ndescription: Round corners\n*/\n.x { --radius: 8px; }`,
      });
      return;
    }
    const index = Number(/theme-(\d+)/.exec(url)?.[1]);
    await route.fulfill({
      body: `/*\n@sable-theme\nname: ${NAMES[index]}\nkind: ${index % 2 === 0 ? 'dark' : 'light'}\ncontrast: ${index % 3 === 0 ? 'high' : 'low'}\n*/\n.x { --sable-bg-container: #101018; }`,
    });
  });
  await page.goto('/settings/appearance');
  await page.getByRole('button', { name: 'Theme catalogue', exact: true }).click();
  await expect(
    page.getByRole('tabpanel').getByRole('button', { name: 'Install', exact: true })
  ).toHaveCount(NAMES.length);
  await expect(page.locator('.catalog')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
});

async function expectStableScroll(panel: Locator, top: number): Promise<void> {
  const offsets = await panel.evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const offsets: number[] = [];
        const until = performance.now() + 1200;
        const sample = () => {
          offsets.push(element.scrollTop);
          if (performance.now() < until) requestAnimationFrame(sample);
          else resolve(offsets);
        };
        requestAnimationFrame(sample);
      })
  );
  expect(Math.min(...offsets)).toBe(top);
  expect(Math.max(...offsets)).toBe(top);
}

for (const scale of [1, 1.5]) {
  test(`mobile: catalogue controls fit with text scale ${scale}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate((scale) => {
      localStorage.setItem(
        'sable-preferences',
        JSON.stringify({ pageZoom: scale, textScale: scale })
      );
    }, scale);
    await page.reload();
    await page.getByRole('button', { name: 'Theme catalogue', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Theme catalogue', exact: true });
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('button', { name: /^Theme 30\b/ })).toBeAttached();
    await panel.getByRole('button', { name: /^Theme 30\b/ }).click();
    const revert = dialog.getByRole('button', { name: 'Revert', exact: true });
    const use = dialog.getByRole('button', { name: 'Use for dark mode', exact: true });
    await expect(revert).toBeInViewport();
    await expect(use).toBeInViewport();
    await expect(
      dialog.getByRole('button', { name: 'Close catalogue', exact: true })
    ).toBeInViewport();
    expect(
      await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBeLessThanOrEqual(1);
    await revert.click();
    const top = await panel.evaluate((element) => element.scrollTop);
    expect(top).toBeGreaterThan(0);
    await expectStableScroll(panel, top);
  });
}
