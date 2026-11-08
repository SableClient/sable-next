import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const spaces = ['Alpha', 'Beta'];
const root = (name: string) => `/space/!${name.toLowerCase()}%3Aexample.test`;
const general = (name: string) => `${root(name)}/!room%3Aexample.test`;
const random = (name: string) => `${root(name)}/!second%3Aexample.test`;

async function shareRoomsAcrossSpaces(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__e2eEmitTimelineEvent({
      type: 'room_list_diff',
      subscription: 1,
      diffs: [],
      sections: {
        sections: ['alpha', 'beta'].map((name) => ({
          key: `!${name}:example.test`,
          favourites: [],
          rooms: ['!room:example.test', '!second:example.test'],
          subspaces: [],
          calendars: [],
          invites: [],
          unread: { unread: 0, notifying: 0, highlight: 0, marked: false },
          unread_rooms: [],
          descendants: [],
        })),
        removed: [],
        badges: [],
        quiet_rooms: [],
      },
    });
  });
}

test.beforeEach(async ({ page, installRoomCore }) => {
  await installRoomCore('spaces');
  await page.addInitScript(() => {
    localStorage.setItem(
      'sable-space-paths',
      JSON.stringify({
        '!alpha:example.test': '/space/!alpha%3Aexample.test/!room%3Aexample.test',
        '!beta:example.test': '/space/!beta%3Aexample.test/!room%3Aexample.test',
      })
    );
  });
});

test('mobile: Back returns to the selected space', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/rooms');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('treeitem', { name: 'Alpha', exact: true })).toBeVisible();
  await shareRoomsAcrossSpaces(page);
  const drawer = page.locator('#drawer-toggle');

  for (const name of spaces) {
    await nav.getByRole('treeitem', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${general(name)}$`));
    await expect(drawer).toHaveAttribute('aria-pressed', 'true');

    await nav.locator(`a.room-row[href="${general(name)}"]`).click();
    await expect(drawer).toHaveAttribute('aria-pressed', 'false');
    await page.goBack();
    await expect(drawer).toHaveAttribute('aria-pressed', 'true');
    await expect(nav.getByRole('heading', { name, exact: true })).toBeVisible();

    await nav.locator(`a.room-row[href="${random(name)}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${random(name)}$`));
    await expect(drawer).toHaveAttribute('aria-pressed', 'false');
    await page.goBack();
    await expect(drawer).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(new RegExp(`${random(name)}$`));
    await expect(nav.locator(`a.room-row[href="${random(name)}"]`)).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(nav.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${random(name)}$`));
    await expect(drawer).toHaveAttribute('aria-pressed', 'false');

    if (name === 'Beta') {
      await page.reload();
      await expect(drawer).toHaveAttribute('aria-pressed', 'false');
    }
    await page.getByRole('button', { name: 'Back to rooms', exact: true }).click();
    await expect(drawer).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(new RegExp(`${random(name)}$`));
  }

  await page.goBack();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('mobile: Back closes dialogs before returning to the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(root('Alpha'));
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
  await shareRoomsAcrossSpaces(page);
  await nav.locator(`a.room-row[href="${general('Alpha')}"]`).click();
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Leave room', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#drawer-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(new RegExp(`${general('Alpha')}$`));

  await page.goBack();
  await expect(page.locator('#drawer-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(nav.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${general('Alpha')}$`));

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${root('Alpha')}$`));
});

test('desktop Back keeps the selected space', async ({ page }) => {
  await page.goto('/rooms');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('treeitem', { name: 'Alpha', exact: true })).toBeVisible();
  await shareRoomsAcrossSpaces(page);

  for (const name of spaces) {
    await nav.getByRole('treeitem', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${general(name)}$`));
    await nav.locator(`a.room-row[href="${random(name)}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${random(name)}$`));

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${general(name)}$`));
    await expect(nav.getByRole('heading', { name, exact: true })).toBeVisible();
  }
});
