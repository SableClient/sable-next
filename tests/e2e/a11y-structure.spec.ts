import { violations, tabStops, type KnownViolation } from './fixtures/a11y';
import { TIMELINE_ROOM_NAME } from './fixtures/continuwuity';
import { expect, test, SIGNED_OUT } from './fixtures/test';

const SEPARATOR_SLOT: KnownViolation = {
  rule: 'target-size',
  html: /composer-separator-control/,
  reason: 'the composer board separator slot is 10px wide by design',
};

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, signIn }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn();
});

test('every settings category has no accessibility violations', async ({ page }) => {
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();

  const categories = await page
    .locator('a[href^="/settings/"]')
    .evaluateAll((links) => [
      ...new Set(
        links
          .map((link) => link.getAttribute('href') ?? '')
          .filter((href) => /^\/settings\/[\w-]+$/.test(href))
      ),
    ]);
  expect(categories.length).toBeGreaterThan(3);

  const failing: Record<string, string[]> = {};
  for (const href of categories) {
    await page.goto(href);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    const found = await violations(page, { known: [SEPARATOR_SLOT] });
    if (found.length) failing[href] = found.map((violation) => violation.id);
  }
  expect(failing).toEqual({});
});

test('the settings categories are one tab stop', async ({ page }) => {
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  const categories = page.locator('.settings-nav-item');
  const total = await categories.count();
  expect(total).toBeGreaterThan(3);

  const reachable = await categories.evaluateAll(
    (items) => items.filter((item) => (item as HTMLElement).tabIndex >= 0).length
  );
  expect(reachable).toBe(1);

  await categories.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(categories.nth(1)).toBeFocused();
});

test.describe('room view tab stops', () => {
  test.beforeEach(async ({ app, homeserver, page, timeline }) => {
    await app.openRooms();
    await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
    await app.openRoom(homeserver.timelineRoomId);
    await expect(timeline.items.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('the room header actions are one tab stop', async ({ page }) => {
    const toolbar = page.getByRole('toolbar', { name: 'Room actions' });
    const stops = await tabStops(toolbar);
    expect(stops, stops.join('\n')).toHaveLength(1);

    await toolbar.getByRole('button').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button').nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(toolbar.getByRole('button').last()).toBeFocused();
  });

  test('the timeline is one tab stop', async ({ page }) => {
    const stops = await tabStops(page.getByRole('feed'));
    expect(stops, stops.join('\n')).toHaveLength(1);
  });

  test('the spaces rail and room list are one tab stop each', async ({ page }) => {
    for (const tree of [
      page.locator('[data-focus-region="spaces"]'),
      page.locator('[data-focus-region="rooms"]'),
    ]) {
      const stops = await tabStops(tree);
      expect(stops, stops.join('\n')).toHaveLength(1);
    }
  });
});
