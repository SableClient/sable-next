// A core that never finishes restoring, or fails to start, has no server-side
// trigger, so those states are scripted.

import { expect, test } from './fixtures/test';

test('renders a startup state while the core is restoring', async ({ app, installEmptyCore }) => {
  await installEmptyCore('loading');
  await app.openHome();

  await expect(app.startupStatus).toContainText('Starting Sable');
  await expect(app.startupHeading).toBeVisible();
});

test('renders a recoverable error when the core cannot start', async ({
  app,
  installEmptyCore,
}) => {
  await installEmptyCore('error');
  await app.openHome();

  await expect(app.startupError).toContainText('Sable could not start');
  await expect(app.retryButton).toBeVisible();
});

test('redirects signed-out protected routes to login', async ({ page }) => {
  await page.goto('/home');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
