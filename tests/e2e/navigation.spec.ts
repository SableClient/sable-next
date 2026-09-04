import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

// "Create room" is omitted: the rail and the room list both render that link,
// so the name is ambiguous. rooms.spec.ts covers the page.
const RAIL_DESTINATIONS = [
  { link: 'Search messages', path: '/search' },
  { link: 'Direct messages', path: '/direct' },
] as const;

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
  await expect(page.getByRole('button', { name: 'Account' }).last()).toBeVisible();
});

test('dismissing the inbox popover returns to the previous page', async ({ page, app }) => {
  await app.openRooms();

  await page.getByRole('link', { name: 'Inbox' }).first().click();
  const inbox = page.getByRole('region', { name: 'Inbox' });
  await expect(inbox).toBeVisible();
  await expect(page).toHaveURL(/\/rooms$/);

  await page.keyboard.press('Escape');

  await expect(inbox).toBeHidden();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('closing the inbox sheet returns to the previous page', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.openRooms();
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible()) await dismiss.click();

  await page.getByRole('link', { name: 'Inbox' }).first().click();
  const inbox = page.getByRole('region', { name: 'Inbox' });
  await expect(inbox).toBeVisible();
  await expect(page).toHaveURL(/\/rooms$/);

  await page.getByRole('button', { name: 'Close' }).click();

  await expect(inbox).toBeHidden();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('opens a settings section over the app shell', async ({ page, app }) => {
  await page.goto('/settings/appearance');

  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(app.primaryNavigation).toBeVisible();
});

test('closes settings and returns to the app', async ({ page, app }) => {
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();

  await app.closeSettings.first().click();

  await expect(page).not.toHaveURL(/\/settings/);
  await expect(app.primaryNavigation).toBeVisible();
});
