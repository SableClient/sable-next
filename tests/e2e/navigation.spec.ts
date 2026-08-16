import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

// "Create room" is omitted: the rail and the room list both render that link,
// so the name is ambiguous. rooms.spec.ts covers the page.
const RAIL_DESTINATIONS = [
  { link: 'Navigate', path: '/navigate' },
  { link: 'Direct messages', path: '/direct' },
] as const;

for (const { link, path } of RAIL_DESTINATIONS) {
  test(`reaches ${path} from the primary navigation`, async ({ page, app, signIn }) => {
    await signIn();

    await app.primaryNavigation.getByRole('link', { name: link, exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(
      app.primaryNavigation.getByRole('link', { name: link, exact: true })
    ).toHaveAttribute('aria-current', 'page');
  });
}

test('opens a settings section over the app shell', async ({ page, app, signIn }) => {
  await signIn();
  await page.goto('/settings/appearance');

  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(app.primaryNavigation).toBeVisible();
});

test('closes settings and returns to the app', async ({ page, app, signIn }) => {
  await signIn();
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();

  await app.closeSettings.first().click();

  await expect(page).not.toHaveURL(/\/settings/);
  await expect(app.primaryNavigation).toBeVisible();
});
