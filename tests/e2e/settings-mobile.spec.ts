import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, hasTouch: true, viewport: { width: 412, height: 915 } });

async function holdAt(page: Page, x: number, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function swipeRight(page: Page, y: number, fromX: number, toX: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', fromX);
  for (let x = fromX + 12; x <= toX; x += 12) await touch('touchMove', x);
  await touch('touchEnd', toX);
}

test('mobile: the page title opens a sheet that jumps to a section', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/settings/timeline');

  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'On this page: Timeline' });
  await sheet.getByRole('button', { name: 'Members & pronouns' }).click();

  await expect(sheet).toBeHidden();
  const heading = page.getByRole('heading', { name: 'Members & pronouns' });
  await expect(heading).toBeInViewport();
  const scroller = page.locator('.settings-scroll');
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

test('mobile: tapping a setting toggles its switch beside the label', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/settings/timeline');

  const row = page.locator('#hide-typing-indicators');
  await row.scrollIntoViewIfNeeded();
  const toggle = row.getByRole('switch');
  const before = await toggle.getAttribute('aria-checked');
  const hint = await row
    .getByText('Nobody typing is announced at the foot of the timeline.')
    .boundingBox();
  if (!hint) throw new Error('The row is not laid out.');
  await page.touchscreen.tap(hint.x + 8, hint.y + hint.height / 2);
  await expect(toggle).not.toHaveAttribute('aria-checked', before ?? '');

  const name = await row.getByText('Hide typing indicators').boundingBox();
  const control = await toggle.boundingBox();
  if (!name || !control) throw new Error('The row is not laid out.');
  expect(control.y).toBeLessThan(name.y + name.height);
  expect(control.x).toBeGreaterThan(name.x + name.width);
});

test('mobile: holding a setting copies its link instead of showing an icon', async ({
  page,
  installRoomCore,
  browserName,
  context,
}) => {
  test.skip(browserName !== 'chromium', 'touch is driven over CDP');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installRoomCore('ready');
  await page.goto('/settings/timeline');

  const row = page.locator('#hide-read-receipts');
  await row.scrollIntoViewIfNeeded();
  await expect(row.getByRole('button', { name: 'Copy link' })).toBeHidden();
  const toggle = row.getByRole('switch');
  const before = await toggle.getAttribute('aria-checked');
  const title = await row.getByText('Hide read receipts').boundingBox();
  if (!title) throw new Error('The row is not laid out.');
  await holdAt(page, title.x + 4, title.y + title.height / 2);

  await expect(page.getByText('Link copied')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', before ?? '');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    '/settings/timeline?focus=hide-read-receipts'
  );
});

test('mobile: swiping a page right goes back to the list', async ({
  page,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'touch is driven over CDP');
  await installRoomCore('ready');
  await page.goto('/settings/timeline');
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toBeVisible();

  await swipeRight(page, 400, 40, 80);
  await expect(sections).toBeHidden();

  await swipeRight(page, 400, 40, 340);
  await expect(sections).toBeVisible();
});

test('mobile: dragging a slider does not swipe the page away', async ({
  page,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'touch is driven over CDP');
  await installRoomCore('ready');
  await page.goto('/settings/appearance');
  const slider = page.getByRole('slider').first();
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  if (!box) throw new Error('The slider is not laid out.');

  await swipeRight(page, box.y + box.height / 2, box.x + 4, box.x + box.width);

  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toBeVisible();
});

test('mobile: a row with several buttons wraps them under its description', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/settings/account');

  const row = page.locator('#settings-file');
  await row.scrollIntoViewIfNeeded();
  const description = await row.locator('p').boundingBox();
  const rowBox = await row.boundingBox();
  if (!description || !rowBox) throw new Error('The row is not laid out.');
  expect(description.width).toBeGreaterThan(rowBox.width * 0.6);
});

test('mobile: a dropdown opens as a sheet of choices', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/settings/appearance');

  await page.getByRole('button', { name: 'Message spacing' }).click();
  const sheet = page.getByRole('dialog', { name: 'Message spacing' });
  const choice = sheet.getByRole('radio', { name: 'Roomy' });
  await choice.click();

  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Message spacing' })).toContainText('Roomy');
});

test('mobile: log out is the last row of the section list', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/settings');

  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  const logout = nav.getByRole('button', { name: 'Log out' });
  await logout.scrollIntoViewIfNeeded();
  const about = await nav.getByRole('link', { name: 'About' }).boundingBox();
  const row = await logout.boundingBox();
  if (!about || !row) throw new Error('The list is not laid out.');
  expect(row.y).toBeGreaterThan(about.y);
});

const THEME_FILES = 'https://raw.githubusercontent.com/SableClient/themes/main/';
const DRACULA = `/*
@sable-theme
name: Dracula
author: e2e
kind: dark
*/
.x { --sable-bg-container: #282a36; --sable-surface-container: #343746; --sable-primary-main: #bd93f9; --sable-bg-on-container: #f8f8f2; }`;

async function routeCatalogue(page: Page, requested: string[] = []): Promise<void> {
  await page.route('https://**/*', (route) => {
    const url = route.request().url();
    if (!url.startsWith('https://raw.githubusercontent.com/')) return route.continue();
    requested.push(url);
    if (url.endsWith('catalog.json')) {
      return route.fulfill({
        json: {
          themes: [
            {
              basename: 'dracula',
              previewUrl: null,
              fullUrl: `${THEME_FILES}themes/dracula.sable.css`,
            },
            {
              basename: 'outside',
              previewUrl: null,
              fullUrl: 'https://raw.githubusercontent.com/else/where/x.sable.css',
            },
          ],
          tweaks: [
            {
              basename: 'compact',
              previewUrl: null,
              fullUrl: `${THEME_FILES}tweaks/compact.sable.css`,
            },
          ],
        },
      });
    }
    if (url.includes('/tweaks/')) {
      return route.fulfill({ body: '/*\n@sable-tweak\nname: Compact rows\n*/' });
    }
    return route.fulfill({ body: DRACULA });
  });
}

test('mobile: a catalogue theme installs into its slot and can be undone', async ({
  page,
  installRoomCore,
}) => {
  const requested: string[] = [];
  await routeCatalogue(page, requested);
  await installRoomCore('ready');
  await page.goto('/settings/appearance');

  await page.getByRole('button', { name: 'Browse themes' }).click();
  const catalogue = page.getByRole('dialog', { name: 'Theme catalogue' });
  await catalogue.getByRole('button', { name: 'Install & use' }).click();
  await expect(catalogue.getByText('In use')).toBeVisible();
  expect(requested.some((url) => url.includes('/else/where/'))).toBe(false);

  await expect(catalogue.getByText('Compact rows')).toHaveCount(0);
  await catalogue.getByRole('tab', { name: /Tweaks/ }).click();
  await expect(catalogue.getByText('Compact rows')).toBeVisible();
  await expect(catalogue.getByRole('button', { name: 'Dark theme' })).toHaveCount(0);

  await catalogue.getByRole('button', { name: 'Close catalogue' }).click();
  const dark = page.getByRole('radiogroup', { name: 'Dark mode' });
  await expect(dark.getByRole('radio', { name: 'Dracula' })).toHaveAttribute(
    'aria-checked',
    'true'
  );

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(dark.getByRole('radio', { name: 'Dracula' })).toHaveCount(0);
  await expect(dark.getByRole('radio', { name: 'Sable' })).toHaveAttribute('aria-checked', 'true');
});

test('mobile: tapping a catalogue theme tries it on until it is kept', async ({
  page,
  installRoomCore,
}) => {
  await routeCatalogue(page);
  await installRoomCore('ready');
  await page.goto('/settings/appearance');

  await page.getByRole('button', { name: 'Browse themes' }).click();
  const catalogue = page.getByRole('dialog', { name: 'Theme catalogue' });
  await catalogue.getByRole('button', { name: /^Dracula/ }).click();
  await expect(catalogue.getByText('Previewing Dracula in dark mode')).toBeVisible();
  await page.screenshot({ path: '/tmp/fx/pv-mobile.png' });

  await catalogue.getByRole('button', { name: 'Keep theme' }).click();
  await expect(catalogue.getByText('In use for dark mode')).toBeVisible();
  await catalogue.getByRole('button', { name: 'Close catalogue' }).click();
  const dark = page.getByRole('radiogroup', { name: 'Dark mode' });
  await expect(dark.getByRole('radio', { name: 'Dracula' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
});
