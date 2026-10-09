import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('renders a startup state while the core is restoring', async ({ app, installEmptyCore }) => {
  await installEmptyCore('loading');
  await app.openRooms();

  await expect(app.startupStatus).toContainText('Starting Sable');
  await expect(app.startupHeading).toBeVisible();
});

test('offers recovery when the core cannot restore the session', async ({
  page,
  app,
  installEmptyCore,
}) => {
  await installEmptyCore('error');
  await app.openRooms();

  await expect(
    page.getByRole('heading', { name: 'Unable to restore your session.' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?addAccount=1$/);
  await expect(page.getByRole('heading', { name: 'Add account' })).toBeVisible();
});

test('redirects signed-out protected routes to login', async ({ page }) => {
  await page.goto('/rooms');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
