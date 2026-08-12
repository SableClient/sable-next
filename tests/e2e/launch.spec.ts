import { expect, test } from '@playwright/test';

test('starts at the sign-in flow', async ({ page }) => {
  const workerErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /worker script/i.test(message.text())) {
      workerErrors.push(message.text());
    }
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(workerErrors).toEqual([]);
});
