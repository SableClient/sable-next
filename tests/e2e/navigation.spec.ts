import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test } from './fixtures/test';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

// "Create room" sits behind the rail's add menu; rooms.spec.ts covers the page.
const RAIL_DESTINATIONS = [{ link: 'Direct messages', path: '/direct' }] as const;

for (const { link, path } of RAIL_DESTINATIONS) {
  test(`reaches ${path} from the primary navigation`, async ({ page, app }) => {
    await app.openRooms();

    await app.primaryNavigation.getByRole('link', { name: link, exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(
      app.primaryNavigation.getByRole('link', { name: link, exact: true })
    ).toHaveAttribute('aria-current', 'page');
  });
}

// aria-pressed on the panel toggle is which panel is showing.
const MOBILE_DESTINATIONS = [
  { path: '/explore', heading: 'Explore rooms' },
  { path: '/create-room', heading: 'Create a room' },
  { path: '/inbox', heading: 'Inbox' },
] as const;

for (const { path, heading } of MOBILE_DESTINATIONS) {
  test(`shows ${path} instead of the room list on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);

    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show room list' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
}

test('separates the room directory filters from the join-by-address section', async ({ page }) => {
  await page.goto('/explore');

  const joinSection = page.getByRole('region', { name: en.room.directoryJoinByAddress });
  const filters = page.locator('.directory .filters');
  await expect(filters).toBeVisible();

  const joinBounds = await joinSection.boundingBox();
  const filterBounds = await filters.boundingBox();

  if (joinBounds === null || filterBounds === null) {
    throw new Error('Explore sections must have layout bounds');
  }

  expect(filterBounds.y - (joinBounds.y + joinBounds.height)).toBeGreaterThanOrEqual(20);
});

test('opens the chats list first, and reaches the new-chat form from there', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/direct');

  const showConversation = page.getByRole('button', { name: 'Show conversation' });
  await expect(showConversation).toHaveAttribute('aria-pressed', 'true');

  // Clipped out of the viewport, so a pointer cannot reach it.
  await showConversation.focus();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('button', { name: 'Show room list' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await expect(page.getByRole('button', { name: 'Start chat' })).toBeVisible();
});

test('keeps the mobile quick tools visible on inbox', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/inbox');

  await expect(page.getByRole('navigation', { name: 'Quick tools' }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: en.nav.manageAccounts }).last()).toBeVisible();
});

test('the desktop inbox link opens the inbox page, and back returns to the rooms', async ({
  page,
  app,
}) => {
  await app.openRooms();

  await page.getByRole('link', { name: 'Inbox' }).first().click();
  const inbox = page.getByRole('heading', { name: 'Inbox', level: 1 });
  await expect(inbox).toBeVisible();
  await expect(page).toHaveURL(/\/inbox$/);

  await page.goBack();

  await expect(inbox).toBeHidden();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('the mobile inbox tab opens the inbox page, and back returns to the rooms', async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.openRooms();

  await app.mobileQuickTools.getByRole('link', { name: 'Inbox' }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('opens a settings section over the app shell', async ({ page, app }) => {
  await page.goto('/settings/appearance');

  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible({
    timeout: COLD_BOOT_TIMEOUT,
  });
  await expect(app.primaryNavigation).toBeVisible();
});

test('closes settings and returns to the app', async ({ page, app }) => {
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible({
    timeout: COLD_BOOT_TIMEOUT,
  });

  await app.closeSettings.first().click();

  await expect(page).not.toHaveURL(/\/settings/);
  await expect(app.primaryNavigation).toBeVisible();
});
