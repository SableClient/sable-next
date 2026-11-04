import { tabTo, violations } from './fixtures/a11y';
import { TIMELINE_ROOM_NAME } from './fixtures/continuwuity';
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.describe('signed in as the shared account', () => {
  test.beforeEach(async ({ app, page, signIn }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn();
    await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
  });

  test('the app shell exposes skip link, navigation and trees as landmarks', async ({ page }) => {
    await expect(page.locator('body')).toMatchAriaSnapshot(`
      - link "Skip to main content"
      - complementary:
        - navigation "Primary navigation":
          - navigation "Navigation":
            - tree "Navigation"
          - region "Rooms":
            - tree "Rooms":
              - treeitem "Rooms" [expanded]
              - treeitem "Timeline fixture"
    `);
    await expect(page.getByRole('main')).toHaveCount(1);
    expect(await violations(page)).toEqual([]);
  });

  test('Tab enters the spaces rail and the room list once each', async ({ page }) => {
    const spaces = page.locator('[data-focus-region="spaces"]');
    const rooms = page.locator('[data-focus-region="rooms"]');
    await page.locator('.skip-link').focus();

    await tabTo(page, spaces.locator('[tabindex="0"]'));
    await page.keyboard.press('Tab');
    await expect(spaces.locator(':focus')).toHaveCount(0);

    await tabTo(page, rooms.locator('[tabindex="0"]'));
    await page.keyboard.press('Tab');
    await expect(rooms.locator(':focus')).toHaveCount(0);
  });

  test('arrows, Home and End move between room list rows', async ({ page }) => {
    const items = page.locator('[data-focus-region="rooms"]').getByRole('treeitem');
    await items.first().focus();

    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
  });

  test('Left and Right collapse and expand the rooms section', async ({ app, page }) => {
    const section = page.locator('[data-focus-region="rooms"]').getByRole('treeitem', {
      name: 'Rooms',
      exact: true,
    });
    await section.focus();
    await expect(section).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('ArrowLeft');
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeHidden();

    await page.keyboard.press('ArrowRight');
    await expect(section).toHaveAttribute('aria-expanded', 'true');
    await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(
      page.locator('[data-focus-region="rooms"]').getByRole('treeitem').nth(1)
    ).toBeFocused();
  });

  test('the context menu key opens the room menu', async ({ app, page }) => {
    await app.roomLink(TIMELINE_ROOM_NAME).focus();

    await page.keyboard.press('ContextMenu');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('Enter opens the focused room', async ({ app, homeserver, page }) => {
    await app.roomLink(TIMELINE_ROOM_NAME).focus();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(homeserver.timelineRoomId)));
    await expect(app.roomHeading(TIMELINE_ROOM_NAME)).toBeVisible();
  });
});

test('Left and Right expand a space folder and move into and out of it', async ({
  page,
  spacesLogin,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await spacesLogin();
  const rail = page.locator('[data-focus-region="spaces"]');
  const space = (name: string) => rail.getByRole('treeitem', { name, exact: true });
  await expect(space('Beta')).toBeVisible({ timeout: 30_000 });

  await expect(async () => {
    await space('Beta').dragTo(space('Alpha'));
    await expect(space('Folder Alpha, Beta')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });

  const folder = space('Folder Alpha, Beta');
  await folder.focus();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('ArrowRight');
  const collapse = space('Collapse Alpha, Beta');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.focus();

  await page.keyboard.press('ArrowRight');
  await expect(space('Alpha')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(collapse).toBeFocused();

  await page.keyboard.press('ArrowLeft');
  await expect(space('Folder Alpha, Beta')).toHaveAttribute('aria-expanded', 'false');
});
