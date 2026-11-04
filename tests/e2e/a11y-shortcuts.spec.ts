import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const REGIONS = {
  spaces: '[data-focus-region="spaces"]',
  rooms: '[data-focus-region="rooms"]',
  timeline: '[role="feed"]',
  composer: '[data-focus-region="composer"]',
  panel: '[data-focus-region="panel"]',
} as const;

async function expectFocusIn(page: Page, name: keyof typeof REGIONS): Promise<void> {
  const selector = REGIONS[name];
  await expect(page.locator(`${selector}:has(:focus), ${selector}:focus`)).toHaveCount(1);
}

test.beforeEach(async ({ app, page, scratchRoom, signIn }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await expect(app.composer).toBeVisible({ timeout: 30_000 });
});

test('Alt+Shift+C, T, R and S focus the composer, timeline, room list and spaces', async ({
  app,
  page,
}) => {
  await app.composer.focus();
  await page.keyboard.press('Alt+Shift+T');
  await expectFocusIn(page, 'timeline');
  await page.keyboard.press('Alt+Shift+C');
  await expect(app.composer).toBeFocused();
  await page.keyboard.press('Alt+Shift+R');
  await expectFocusIn(page, 'rooms');
  await page.keyboard.press('Alt+Shift+S');
  await expectFocusIn(page, 'spaces');
  await page.keyboard.press('Alt+Shift+C');
  await expect(app.composer).toBeFocused();
});

test('the region shortcuts work from inside the composer', async ({ app, page }) => {
  for (const [key, name] of [
    ['Alt+Shift+T', 'timeline'],
    ['Alt+Shift+R', 'rooms'],
    ['Alt+Shift+S', 'spaces'],
  ] as const) {
    await app.composer.focus();
    await page.keyboard.press(key);
    await expectFocusIn(page, name);
  }
});

test('F6 and Shift+F6 cycle the regions and wrap', async ({ app, page }) => {
  await page.locator(REGIONS.spaces).locator('[tabindex="0"]').focus();

  for (const name of ['rooms', 'timeline'] as const) {
    await page.keyboard.press('F6');
    await expectFocusIn(page, name);
  }
  await page.keyboard.press('F6');
  await expect(app.composer).toBeFocused();
  await page.keyboard.press('F6');
  await expectFocusIn(page, 'panel');
  await page.keyboard.press('F6');
  await expectFocusIn(page, 'spaces');

  await page.keyboard.press('Shift+F6');
  await expectFocusIn(page, 'panel');
  await page.keyboard.press('Shift+F6');
  await expect(app.composer).toBeFocused();
});

test('clicking a room in the list focuses its message field', async ({ app, homeserver, page }) => {
  const room = app.roomLink('Timeline fixture');
  await room.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(homeserver.timelineRoomId)));
  await expect(app.composer).toBeFocused();
});

test('opening a room from the command palette focuses its heading', async ({
  app,
  homeserver,
  page,
}) => {
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Jump to room' });
  await dialog.getByRole('combobox').fill('Timeline fixture');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(new RegExp(encodeURIComponent(homeserver.timelineRoomId)));
  await expect(app.roomHeading('Timeline fixture')).toBeFocused();
});

test('the profile editor tabs move and select with the arrow keys', async ({ page }) => {
  await page.goto('/settings/account');
  const tabs = page.getByRole('tablist', { name: 'Profile' });
  const edit = tabs.getByRole('tab', { name: 'Edit' });
  const preview = tabs.getByRole('tab', { name: 'Preview' });
  await edit.focus();

  await page.keyboard.press('ArrowRight');
  await expect(preview).toBeFocused();
  await expect(preview).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(edit).toBeFocused();
  await expect(edit).toHaveAttribute('aria-selected', 'true');
});
