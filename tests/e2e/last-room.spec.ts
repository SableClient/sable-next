import { expect, test } from '@playwright/test';
import { installFakeCore } from './fake-core';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

const roomPath = '/rooms/!room%3Aexample.test';

test.beforeEach(async ({ page }) => {
  await installFakeCore(page, 'ready');
});

test('restores the last room on startup', async ({ page }) => {
  await page.goto(roomPath);
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible({
    timeout: COLD_BOOT_TIMEOUT,
  });
  await page.goto('/rooms');
  await page.goto('/');

  await expect(page).toHaveURL(roomPath);
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
});

test('disabling restoration opens the room list', async ({ page }) => {
  await page.goto(roomPath);
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await page.goto('/settings/appearance');
  const setting = page.getByRole('switch', { name: 'Restore last viewed room', exact: true });
  await expect(setting).toBeChecked();
  await setting.click();
  await page.goto('/');

  await expect(page).toHaveURL(/\/rooms$/);
});

test('opening another room updates the saved room', async ({ page }) => {
  await page.goto(roomPath);
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await page.goto('/rooms/!second%3Aexample.test');

  await expect(page).toHaveURL(/\/rooms\/!second%3Aexample.test$/);
  await expect(page.getByRole('heading', { name: 'Random', exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/rooms\/!second%3Aexample.test$/);
});

test('opens the room list when no room is saved', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/rooms$/);
});

for (const roomId of ['!left:example.test', '!invited:example.test', '!tombstoned:example.test']) {
  test(`skips unavailable rooms: ${roomId}`, async ({ page }) => {
    await installFakeCore(page, 'tombstoned');
    await page.addInitScript((savedRoomId) => {
      localStorage.setItem('sable-last-room:e2e-account', savedRoomId);
    }, roomId);
    await page.goto('/');

    await expect(page).toHaveURL(/\/rooms$/);
  });
}

test('ignores another account’s saved room', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sable-last-room:other-account', '!room:example.test');
  });
  await page.goto('/');

  await expect(page).toHaveURL(/\/rooms$/);
});

test('preserves the requested room after login', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sable-last-room:e2e-account', '!room:example.test');
    sessionStorage.setItem(
      'sable-after-login-path',
      '/rooms/!second%3Aexample.test?event=%24target'
    );
  });
  await page.goto('/');

  await expect(page).toHaveURL(/\/rooms\/!second%3Aexample.test\?event=%24target$/);
});

test('preserves the requested room during setup', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('sable-after-login-path', '/rooms/!second%3Aexample.test');
    localStorage.setItem(
      'sable-setup:@e2e:example.test:E2EDEVICE',
      JSON.stringify({
        full: true,
        registering: false,
        homeserver: 'https://example.test',
        steps: ['device'],
        finished: [],
      })
    );
  });
  await page.goto('/');

  await expect(page).toHaveURL(/\/setup(?:\/|$)/);
  expect(await page.evaluate(() => sessionStorage.getItem('sable-after-login-path'))).toBe(
    '/rooms/!second%3Aexample.test'
  );
});
