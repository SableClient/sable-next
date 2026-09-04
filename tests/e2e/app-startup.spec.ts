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

test('renders a recoverable error when the core cannot start', async ({
  app,
  installEmptyCore,
}) => {
  await installEmptyCore('error');
  await app.openRooms();

  await expect(app.startupError).toContainText('Sable could not start');
  await expect(app.retryButton).toBeVisible();
});

test('redirects signed-out protected routes to login', async ({ page }) => {
  await page.goto('/rooms');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
