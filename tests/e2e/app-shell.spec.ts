import { expect, test } from '@playwright/test';

import { installFakeCore } from './fake-core';

test('shows the authenticated app shell on desktop', async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByRole('navigation', { name: 'Quick tools' })).toBeVisible();

  const appScrollbars = await page.evaluate(() => {
    const roomNavigation = document.querySelector('.room-nav-content');
    return {
      gutter: getComputedStyle(document.documentElement).scrollbarGutter,
      roomNavigation: roomNavigation ? getComputedStyle(roomNavigation).scrollbarWidth : null,
    };
  });
  expect(appScrollbars.gutter).toBe('auto');
  expect(appScrollbars.roomNavigation).toBe('thin');
});

test('persists the keyboard-adjusted room navigation width', async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');

  const resize = page.getByRole('slider', { name: 'Resize rooms' });
  await expect(resize).toHaveAttribute('aria-valuenow', '224');
  await resize.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', '304');

  await page.reload();
  await expect(page.getByRole('slider', { name: 'Resize rooms' })).toHaveAttribute(
    'aria-valuenow',
    '304'
  );
});

test('shows the authenticated app shell on mobile', async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByRole('navigation', { name: 'Quick tools' })).toBeVisible();
});

test('keeps mobile bottom navigation with the room list panel', async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');

  const quickTools = page.getByRole('navigation', { name: 'Quick tools' });
  await expect(quickTools).toBeInViewport();
  await page.getByRole('link', { name: 'General' }).click();

  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to rooms' })).toBeVisible();
  await expect(quickTools).not.toBeInViewport();

  await page.getByRole('button', { name: 'Back to rooms' }).click();
  await expect(quickTools).toBeInViewport();
});

test('renders a startup state while the core is restoring', async ({ page }) => {
  await installFakeCore(page, 'loading');
  await page.goto('/home');

  await expect(page.getByRole('status')).toContainText('Starting Sable');
  await expect(page.getByRole('heading', { name: 'Starting Sable' })).toBeVisible();
});

test('redirects signed-out protected routes to login', async ({ page }) => {
  await page.goto('/home');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('renders a recoverable error when the core cannot start', async ({ page }) => {
  await installFakeCore(page, 'error');
  await page.goto('/home');

  await expect(page.getByRole('alert')).toContainText('Sable could not start');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
