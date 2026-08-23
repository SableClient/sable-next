// Catches the class of defect no linter sees: duplicated landmarks, controls
// with no accessible name, ARIA roles missing the contract they promise.

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test';
import { TIMELINE_ROOM_NAME } from './fixtures/continuwuity';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    // Colour is a design decision, reviewed separately from structure.
    .withTags(TAGS)
    .disableRules(['color-contrast'])
    .analyze();
  return result.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

test('the sign-in page has no accessibility violations', async ({ auth, homeserver, page }) => {
  await auth.open(homeserver.baseUrl);
  await auth.revealPasswordLogin();

  expect(await violations(page)).toEqual([]);
});

// One sign-in for every signed-in surface: the suite shares a single homeserver,
// so a sign-in per assertion starves the other specs.
test('the signed-in surfaces have no accessibility violations', async ({
  app,
  homeserver,
  page,
  signIn,
  timeline,
}) => {
  await signIn();
  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await app.openRoom(homeserver.timelineRoomId);
  await expect(timeline.items.first()).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await app.openInbox();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/search');
  const field = page.getByRole('combobox', { name: /Search messages/ });
  await field.fill('in:Timeline from:e2e ');
  await expect(page.locator('.chip')).toHaveCount(2);

  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await field.press('Alt+ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();

  expect(await violations(page)).toEqual([]);
});
