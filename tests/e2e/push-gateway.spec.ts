// A pusher write is a real request to the homeserver, so what these guard is
// that nothing leaves until Apply.

import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

const GATEWAY = 'https://sygnal.example.test/_matrix/push/v1/notify';

function fields(page: import('@playwright/test').Page) {
  return {
    url: page.getByLabel('Gateway URL'),
    vapid: page.getByLabel('VAPID public key'),
    appId: page.getByLabel('Application ID'),
    apply: page.getByRole('button', { name: 'Apply' }),
    reset: page.getByRole('button', { name: 'Use the default' }),
  };
}

async function storedOverride(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sable-preferences');
    const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    return {
      pushGatewayUrl: parsed.pushGatewayUrl ?? '',
      pushVapidKey: parsed.pushVapidKey ?? '',
      pushAppId: parsed.pushAppId ?? '',
    };
  });
}

test('the deployment default holds until all three fields are applied', async ({ page, app }) => {
  await app.openRooms();
  await expect(app.primaryNavigation).toBeVisible();
  await page.goto('/settings/notifications');

  const { url, vapid, appId, apply } = fields(page);
  await expect(url).toBeVisible();

  await expect(page.getByText(/Using https:\/\//)).toBeVisible();

  await url.fill(GATEWAY);
  await expect(page.getByText(/Fill in all three/)).toBeVisible();
  await expect(apply).toBeDisabled();
  expect(await storedOverride(page)).toEqual({
    pushGatewayUrl: '',
    pushVapidKey: '',
    pushAppId: '',
  });

  await vapid.fill('BCnS4SbHje');
  await appId.fill('org.example.web');
  await expect(apply).toBeEnabled();

  expect(await storedOverride(page)).toEqual({
    pushGatewayUrl: '',
    pushVapidKey: '',
    pushAppId: '',
  });

  await apply.click();
  expect(await storedOverride(page)).toEqual({
    pushGatewayUrl: GATEWAY,
    pushVapidKey: 'BCnS4SbHje',
    pushAppId: 'org.example.web',
  });
  await expect(apply).toBeDisabled();
});

test('an address the core would refuse cannot be applied', async ({ page, app }) => {
  await app.openRooms();
  await expect(app.primaryNavigation).toBeVisible();
  await page.goto('/settings/notifications');

  const { url, vapid, appId, apply } = fields(page);
  await expect(url).toBeVisible();

  await vapid.fill('BCnS4SbHje');
  await appId.fill('org.example.web');

  for (const refused of [
    'http://sygnal.example.test/_matrix/push/v1/notify',
    'https://sygnal.example.test/',
    'not a url',
  ]) {
    await url.fill(refused);
    await expect(apply).toBeDisabled();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
  }

  await url.fill(GATEWAY);
  await expect(apply).toBeEnabled();
  await expect(url).not.toHaveAttribute('aria-invalid', 'true');
});

test('the default comes back on reset', async ({ page, app }) => {
  await app.openRooms();
  await expect(app.primaryNavigation).toBeVisible();
  await page.goto('/settings/notifications');

  const { url, vapid, appId, apply, reset } = fields(page);
  await expect(url).toBeVisible();

  await url.fill(GATEWAY);
  await vapid.fill('BCnS4SbHje');
  await appId.fill('org.example.web');
  await apply.click();

  await reset.click();
  expect(await storedOverride(page)).toEqual({
    pushGatewayUrl: '',
    pushVapidKey: '',
    pushAppId: '',
  });
  await expect(url).toHaveValue('');
  await expect(page.getByText(/Using https:\/\//)).toBeVisible();
});
