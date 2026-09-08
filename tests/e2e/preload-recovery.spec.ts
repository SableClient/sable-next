import { expect, test } from '@playwright/test';

test('does not preload a route on hover, but still handles its error when clicked', async ({
  page,
}) => {
  const errors: Error[] = [];
  let lazyRouteRequests = 0;
  page.on('pageerror', (error) => errors.push(error));
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome to Sable' })).toBeVisible();
  await page.getByRole('button', { name: 'More ways to sign in' }).waitFor();
  await page.evaluate(() => {
    sessionStorage.setItem('sable:dynamic-import-reload', String(Date.now()));
    const link = document.createElement('a');
    link.href = '/register';
    link.textContent = 'Preload target';
    document.querySelector('body > div')?.append(link);
  });
  const target = page.getByRole('link', { name: 'Preload target' });
  await page.route('**/_app/immutable/nodes/**', (route) => {
    lazyRouteRequests += 1;
    return route.abort();
  });

  await target.hover();
  await page.waitForTimeout(250);

  expect(lazyRouteRequests).toBe(0);
  expect(errors).toEqual([]);
  await expect(page).toHaveURL(/\/login$/);

  await target.click();

  await expect.poll(() => lazyRouteRequests).toBeGreaterThan(0);
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByText('Internal Error')).toBeVisible();
  expect(errors).toEqual([]);
});
