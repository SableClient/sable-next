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

test('the theme catalogue keeps its scroll position while idle and on hover', async ({ page }) => {
  const panel = page.getByRole('tabpanel');
  await panel.evaluate((element) => {
    element.scrollTop = 1000;
  });
  const top = await panel.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await expectStableScroll(panel, top);

  const bounds = await panel.boundingBox();
  if (!bounds) throw new Error('catalogue panel has no bounds');
  for (const fraction of [0.25, 0.75]) {
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * fraction);
    await expectStableScroll(panel, top);
  }
});

test('scrolling with the mouse wheel leaves the catalogue at the chosen position', async ({
  page,
}) => {
  const panel = page.getByRole('tabpanel');
  await panel.hover();
  const scrollBy = async (delta: number): Promise<number> => {
    await page.mouse.wheel(0, delta);
    let last = -1;
    let stableSamples = 0;
    await expect
      .poll(
        async () => {
          const next = await panel.evaluate((element) => element.scrollTop);
          stableSamples = next === last ? stableSamples + 1 : 0;
          last = next;
          return stableSamples;
        },
        { intervals: [100] }
      )
      .toBeGreaterThanOrEqual(3);
    return last;
  };
  const down = await scrollBy(1000);
  expect(down).toBeGreaterThan(0);
  await expectStableScroll(panel, down);
  const up = await scrollBy(-200);
  expect(up).toBeLessThan(down);
  await expectStableScroll(panel, up);
});

test('the catalogue can be browsed while more entries load', async ({ page }) => {
  const pending = Promise.withResolvers<undefined>();
  await page.route(`${FILES}themes/**`, async (route) => {
    const index = Number(/theme-(\d+)/.exec(route.request().url())?.[1]);
    if (index >= 30) await pending.promise;
    await route.fallback();
  });
  try {
    await page.reload();
    await page.getByRole('button', { name: 'Theme catalogue', exact: true }).click();
    const panel = page.getByRole('tabpanel');
    const installs = panel.getByRole('button', { name: 'Install', exact: true });
    await expect(installs).toHaveCount(30);
    await expect(page.locator('.catalog')).toHaveAttribute('aria-busy', 'true');
    await panel.evaluate((element) => {
      element.scrollTop = 1000;
    });
    await expectStableScroll(panel, 1000);
    pending.resolve(undefined);
    await expect(installs).toHaveCount(60);
    await expect(page.locator('.catalog')).toHaveAttribute('aria-busy', 'false');
    await expectStableScroll(panel, 1000);
  } finally {
    pending.resolve(undefined);
  }
});

test('a failed catalogue load can be retried', async ({ page }) => {
  let requests = 0;
  await page.route(`${FILES}catalog.json`, async (route) => {
    if (++requests === 1) await route.fulfill({ status: 500, body: '' });
    else await route.fallback();
  });
  await page.reload();
  await page.getByRole('button', { name: 'Theme catalogue', exact: true }).click();
  await expect(
    page.getByText('Could not load the official theme catalog.', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(60);
  await panel.evaluate((element) => {
    element.scrollTop = 1000;
  });
  await expectStableScroll(panel, 1000);
});

test('a theme further down the catalogue can be previewed and installed', async ({ page }) => {
  const panel = page.getByRole('tabpanel');
  const tile = panel.getByTitle('Theme 30', { exact: true });
  await tile.click();
  await expect(page.getByRole('button', { name: 'Revert', exact: true })).toBeVisible();
  await expect(tile).toBeInViewport();
  const top = await panel.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await expectStableScroll(panel, top);

  await tile.locator('..').getByRole('button', { name: 'Install', exact: true }).click();
  await expect(tile.locator('..').getByText('Installed', { exact: true })).toBeVisible();
  await expect(tile).toBeInViewport();
  await expectStableScroll(panel, top);
});

test('filters and keyboard tab navigation work after scrolling', async ({ page }) => {
  const dialog = page.getByRole('dialog', { name: 'Theme catalogue', exact: true });
  const panel = page.getByRole('tabpanel');
  await panel.evaluate((element) => {
    element.scrollTop = 2000;
  });
  await dialog.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(30);
  await dialog.getByRole('button', { name: 'High contrast', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(10);
  const search = dialog.getByRole('searchbox', { name: 'Search themes and tweaks' });
  await search.fill('Theme 03');
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(1);
  await expect(panel.getByTitle('Theme 03')).toBeInViewport();
  await search.fill('no matching theme');
  await expect(panel.getByText('Nothing matches.', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(60);

  const themes = dialog.getByRole('tab', { name: /^Themes/ });
  const tweaks = dialog.getByRole('tab', { name: /^Tweaks/ });
  await themes.focus();
  await themes.press('ArrowRight');
  await expect(tweaks).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(30);
  await panel.evaluate((element) => {
    element.scrollTop = 500;
  });
  await expectStableScroll(panel, await panel.evaluate((element) => element.scrollTop));
  await panel
    .getByRole('listitem')
    .filter({ hasText: 'Tweak 20' })
    .getByRole('button', { name: 'Install', exact: true })
    .click();
  await expect(
    panel
      .getByRole('listitem')
      .filter({ hasText: 'Tweak 20' })
      .getByText('Installed', { exact: true })
  ).toBeVisible();
  await tweaks.focus();
  await tweaks.press('Home');
  await expect(themes).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(60);
});

test('preview can be reverted, kept, and cleared when the catalogue reopens', async ({ page }) => {
  const panel = page.getByRole('tabpanel');
  const theme = panel.getByTitle('Theme 30', { exact: true });
  await theme.click();
  await expect(page.getByRole('button', { name: 'Revert', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revert', exact: true })).toHaveCount(0);
  await expect(theme).toBeInViewport();
  await theme.click();
  await page.getByRole('button', { name: 'Use for dark mode', exact: true }).click();
  await expect(
    theme.locator('..').getByText('In use for dark mode', { exact: true })
  ).toBeVisible();
  await panel.getByTitle('Theme 31', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revert', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close catalogue', exact: true }).click();
  await page.getByRole('button', { name: 'Theme catalogue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revert', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Install', exact: true })).toHaveCount(59);
  await expect(
    panel.getByTitle('Theme 30').locator('..').getByText('In use for dark mode', { exact: true })
  ).toBeAttached();
  await expect(page.locator('.dock .banner')).toBeHidden();
  await page.getByRole('button', { name: 'Close catalogue', exact: true }).click();
  await page
    .locator('.dialog-content-settings')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(page.locator('.dock .banner')).toBeVisible();
});

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
    await expect(panel.getByTitle('Theme 30')).toBeAttached();
    await panel.getByTitle('Theme 30').click();
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
